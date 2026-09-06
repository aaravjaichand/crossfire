/**
 * pnpm tracing:check
 *
 * Tracing sits on the critical path of every model call, so what is checked
 * here is mostly what it must *not* do: it must not change a return value, not
 * swallow or reshape an error, not throw when the ingest endpoint is down or
 * slow, and not do anything at all when no key is configured.
 *
 * The Neatlogs endpoint is stubbed at globalThis.fetch, so the real
 * serialization runs and nothing leaves the machine.
 */
import "./load-env";
import { flushOrphans, recordLlmCall, traceLlmCall, withRunTrace, withSampleSpan } from "./context";
import { clip, countSpans, MAX_TEXT, postTrace } from "./neatlogs";
import type { SpanNode } from "./types";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

type Captured = { url: string; body: SpanNode & { project?: string } };

/** Installs a fake ingest endpoint and returns everything it received. */
function captureFetch(respond: (body: unknown) => Response = () => json({ success: true, spans: 1 })) {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    captured.push({ url: String(url), body });
    return respond(body);
  }) as typeof fetch;
  return captured;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function findSpan(node: SpanNode | undefined, name: string): SpanNode | undefined {
  if (!node) return undefined;
  if (node.name === name) return node;
  for (const child of node.children ?? []) {
    const hit = findSpan(child, name);
    if (hit) return hit;
  }
  return undefined;
}

async function main() {
  const realFetch = globalThis.fetch;
  // The key decides whether tracing is on at all, and .env.local may have set
  // a real one. Every case below sets it explicitly.
  delete process.env.NEATLOGS_API_KEY;
  process.env.NEATLOGS_ENDPOINT = "https://ingest.invalid/v1/trace";

  try {
    // ---- off without a key ----
    {
      const captured = captureFetch();
      const result = await withRunTrace({ runId: 1 }, async () =>
        withSampleSpan({ type: "invoice", id: 5 }, async () =>
          traceLlmCall({ name: "accountant.defense", model: "m", input: "in" }, async () => "out"),
        ),
      );
      check("no NEATLOGS_API_KEY: the run still returns its value", result === "out", result);
      check("no NEATLOGS_API_KEY: nothing is posted", captured.length === 0, `${captured.length} posts`);
    }

    process.env.NEATLOGS_API_KEY = "test-key";

    // ---- the documented tree shape ----
    {
      const captured = captureFetch();
      await withRunTrace({ runId: 12, name: "audit run 12" }, async () => {
        await withSampleSpan({ type: "invoice", id: 15, auditSampleId: 3 }, async () => {
          await traceLlmCall(
            { name: "auditor.question", model: "glm-4-7-flash", input: "ask" },
            async () => "asked",
          );
          await traceLlmCall(
            { name: "accountant.defense", model: "glm-4-7-flash", input: "defend" },
            async () => "defended",
          );
        });
      });

      check("one POST per run", captured.length === 1, `${captured.length} posts`);
      const root = captured[0]?.body;
      check("posted to the configured endpoint", captured[0]?.url === process.env.NEATLOGS_ENDPOINT, captured[0]?.url);
      check("the root is the run", root?.name === "audit run 12" && root?.kind === "WORKFLOW", root?.name);
      check("the root carries the project", root?.project === "crossfire", String(root?.project));
      check("run id is on the root metadata", root?.metadata?.runId === "12", String(root?.metadata?.runId));

      const sample = root?.children?.[0];
      check(
        "one span per sample, named for the sampled row",
        sample?.name === "sample invoice:15" && sample?.kind === "AGENT",
        sample?.name,
      );
      check(
        "the sample span carries its audit_samples id",
        sample?.metadata?.auditSampleId === 3,
        String(sample?.metadata?.auditSampleId),
      );
      check("both model calls hang off the sample", (sample?.children?.length ?? 0) === 2, `${sample?.children?.length}`);
      const defense = findSpan(root, "accountant.defense");
      check(
        "the LLM span records model, input, and output",
        defense?.kind === "LLM" && defense?.model === "glm-4-7-flash" && defense?.input === "defend" && defense?.output === "defended",
        JSON.stringify({ model: defense?.model, input: defense?.input, output: defense?.output }),
      );
      check("the LLM span is timed", typeof defense?.duration_ms === "number", String(defense?.duration_ms));
      check("a successful call is OK", defense?.status === "OK", String(defense?.status));
      check("the tree is four spans", countSpans(root as SpanNode) === 4, String(countSpans(root as SpanNode)));
    }

    // ---- concurrent samples do not cross ----
    {
      const captured = captureFetch();
      await withRunTrace({ runId: 20 }, async () => {
        await Promise.all(
          [1, 2, 3, 4].map((id) =>
            withSampleSpan({ type: "bank_transaction", id }, async () => {
              await new Promise((r) => setTimeout(r, 5 * (5 - id)));
              await traceLlmCall(
                { name: "accountant.defense", model: "m", input: `defend ${id}` },
                async () => `answer ${id}`,
              );
            }),
          ),
        );
      });
      const root = captured[0]?.body;
      const crossed = (root?.children ?? []).filter((sample) => {
        const call = sample.children?.[0];
        return sample.children?.length !== 1 || call?.output !== `answer ${sample.metadata?.sampleId}`;
      });
      check(
        "four concurrent samples each keep their own model call",
        (root?.children?.length ?? 0) === 4 && crossed.length === 0,
        `${root?.children?.length} samples, ${crossed.length} crossed`,
      );
    }

    // ---- values and errors pass through untouched ----
    {
      captureFetch();
      const value = await traceLlmCall({ name: "n", model: "m", input: "i" }, async () => ({ a: 1 }));
      check("a non-string result is returned as-is", value.a === 1, JSON.stringify(value));

      const boom = new Error("model exploded");
      let thrown: unknown;
      try {
        await withRunTrace({ runId: 21 }, async () =>
          withSampleSpan({ type: "invoice", id: 1 }, async () =>
            traceLlmCall({ name: "accountant.defense", model: "m", input: "i" }, async () => {
              throw boom;
            }),
          ),
        );
      } catch (err) {
        thrown = err;
      }
      check("the original error object is rethrown", thrown === boom, String(thrown));
      await flushOrphans();
    }

    // ---- a failing model call is recorded as ERROR ----
    {
      const captured = captureFetch();
      await withRunTrace({ runId: 22 }, async () => {
        await withSampleSpan({ type: "invoice", id: 9 }, async () => {
          try {
            await traceLlmCall({ name: "accountant.defense", model: "m", input: "i" }, async () => {
              throw new Error("401 unauthorized");
            });
          } catch {
            // the real call site falls back here
          }
        });
      });
      const span = findSpan(captured[0]?.body, "accountant.defense");
      check(
        "a failed model call is an ERROR span with the message",
        span?.status === "ERROR" && span?.error === "401 unauthorized",
        `${span?.status} ${span?.error}`,
      );
    }

    // ---- long prompts are clipped ----
    {
      const captured = captureFetch();
      const long = "x".repeat(MAX_TEXT * 3);
      await withRunTrace({ runId: 23 }, async () => {
        await traceLlmCall({ name: "accountant.defense", model: "m", input: long }, async () => long);
      });
      const span = findSpan(captured[0]?.body, "accountant.defense");
      check(
        "prompt and answer are clipped before they are posted",
        (span?.input?.length ?? 0) < MAX_TEXT + 32 && (span?.output?.length ?? 0) < MAX_TEXT + 32,
        `${span?.input?.length}/${span?.output?.length} chars`,
      );
      check("clip() marks what it dropped", clip("abcdef", 3).endsWith("(+3 chars)"), clip("abcdef", 3));
    }

    // ---- a call with no run on the stack is still traced ----
    {
      const captured = captureFetch();
      recordLlmCall({ name: "accountant.defense", model: "m", input: "i", output: "o", startedAt: Date.now(), endedAt: Date.now() });
      await flushOrphans();
      check(
        "a model call outside a run flushes as its own trace",
        captured.length === 1 && captured[0].body.children?.length === 1,
        `${captured.length} posts`,
      );
      await flushOrphans();
      check("flushing an empty buffer posts nothing", captured.length === 1, `${captured.length} posts`);
    }

    // ---- the ingest endpoint cannot break a run ----
    {
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;
      let ok = true;
      try {
        const value = await withRunTrace({ runId: 24 }, async () => "still fine");
        check("a refused connection does not fail the run", value === "still fine", value);
      } catch {
        ok = false;
      }
      check("postTrace never throws on a network error", ok);
      const refused = await postTrace({ name: "n", kind: "WORKFLOW" });
      check("a network error is reported, not thrown", refused.ok === false, refused.ok ? "" : refused.reason);

      globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
      const rejected = await postTrace({ name: "n", kind: "WORKFLOW" });
      check("a 500 from ingest is reported, not thrown", rejected.ok === false, rejected.ok ? "" : rejected.reason);

      globalThis.fetch = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch;
      const started = Date.now();
      const timedOut = await postTrace({ name: "n", kind: "WORKFLOW" }, { timeoutMs: 100 });
      const elapsed = Date.now() - started;
      check(
        "a hung endpoint is abandoned at the timeout",
        timedOut.ok === false && elapsed < 1_000,
        `${elapsed}ms`,
      );
    }

    // ---- explicitly turned off ----
    {
      process.env.CROSSFIRE_NO_TRACING = "1";
      const captured = captureFetch();
      await withRunTrace({ runId: 25 }, async () =>
        traceLlmCall({ name: "n", model: "m", input: "i" }, async () => "v"),
      );
      check("CROSSFIRE_NO_TRACING=1 posts nothing", captured.length === 0, `${captured.length} posts`);
      delete process.env.CROSSFIRE_NO_TRACING;
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(failures === 0 ? "\nAll tracing checks passed." : `\n${failures} tracing check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
