import { parseSampleId } from "@/lib/referee/sample-id";
import { confirmStartRun, runAssistantTurn } from "@/lib/assistant/loop";
import { isToolName, MAX_MESSAGE_CHARS, type AssistantRequest, type AssistantResponse } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
// One turn is bounded at 20s by the loop; the route gets a little more so the
// database writes after the budget still land.
export const maxDuration = 30;

/**
 * POST /api/assistant. No streaming: the paragraph is checked against the
 * rows before it is sent, and a streamed sentence could be retracted
 * mid-render. Failures answer with a result rather than a thrown error, the
 * pattern decide.ts sets; the detail goes to the server log.
 */
export async function POST(request: Request): Promise<Response> {
  let body: Partial<AssistantRequest>;
  try {
    body = (await request.json()) as Partial<AssistantRequest>;
  } catch {
    return reply({ ok: false, message: "The request was not JSON." }, 400);
  }

  const threadId = positiveInt(body.threadId);
  const confirm = positiveInt(body.confirmStartRun);

  if (confirm !== undefined) {
    if (threadId === undefined) return reply({ ok: false, message: "A thread is required to start a run." }, 400);
    try {
      const out = await confirmStartRun(threadId, confirm);
      if ("error" in out) return reply({ ok: false, message: out.error }, 409);
      return reply({ ok: true, ...out });
    } catch (error) {
      console.error("[assistant] starting a run failed", { threadId, confirm, error });
      return reply({ ok: false, message: "The run could not be started. Try again." }, 500);
    }
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return reply({ ok: false, message: "Ask something first." }, 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return reply({ ok: false, message: `Keep a question under ${MAX_MESSAGE_CHARS} characters.` }, 400);
  }
  const runId = typeof body.runId === "string" && /^(\d+|mock)$/.test(body.runId) ? body.runId : undefined;
  const sampleRef =
    typeof body.sampleRef === "string" && parseSampleId(body.sampleRef) ? body.sampleRef : undefined;
  const forceTool = isToolName(body.forceTool) ? body.forceTool : undefined;

  try {
    const out = await runAssistantTurn({ threadId, message, runId, sampleRef, forceTool });
    return reply({ ok: true, ...out });
  } catch (error) {
    console.error("[assistant] turn failed", { threadId, error });
    return reply({ ok: false, message: "The assistant could not answer. Try again." }, 500);
  }
}

function reply(body: AssistantResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
