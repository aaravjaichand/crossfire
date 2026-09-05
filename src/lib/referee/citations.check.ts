/**
 * pnpm referee:check-citations
 *
 * Holds the mock run to the same citation invariant the accountant enforces on
 * model prose, using the accountant's own validator rather than a looser copy:
 * every factual sentence must carry an inline [table#id] naming a row that is
 * actually in that turn's bundle, and no bracket may name a row that is not.
 *
 * It also proves the two claims the review called out as uncited — the
 * invoice-49 bank payment and the invoice-41 approver — are now backed by real
 * rows, and that every cited row resolves against the seeded database.
 *
 * Needs DATABASE_URL pointed at a seeded crossfire_c.
 */
import "./load-env";
import { splitSentences, validateDefense } from "@/lib/accountant/citations";
import type { EvidenceBundle } from "./evidence-types";
import { loadMockTables, SAMPLES, turnBundle, type Tables } from "./mock-run";
import { formatSampleId } from "./sample-id";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function hasCitation(bundle: EvidenceBundle, table: string, id: number, field: string): boolean {
  return bundle.citations.some((c) => c.table === table && c.id === id && c.field === field);
}

async function main() {
  const tables: Tables = await loadMockTables();

  let turnsChecked = 0;
  let auditorTurns = 0;
  let accountantTurns = 0;
  let sentencesChecked = 0;

  for (const spec of SAMPLES) {
    const sampleId = formatSampleId(spec.ref);
    for (const [i, turn] of spec.turns.entries()) {
      // Resolving throws if a cited row is not in the database, so reaching
      // the validator at all proves every citation points at a real row.
      const bundle = turnBundle(spec, turn, tables);
      const result = validateDefense(turn.content, bundle);
      check(
        `${sampleId} turn ${i + 1} (${turn.role}) satisfies the citation invariant`,
        result.ok,
        result.ok ? `${bundle.citations.length} rows cited` : result.reason,
      );
      turnsChecked++;
      sentencesChecked += splitSentences(turn.content).length;
      if (turn.role === "auditor") auditorTurns++;
      else accountantTurns++;
    }
  }

  check("every sample has at least one auditor and one accountant turn", auditorTurns >= SAMPLES.length && accountantTurns >= SAMPLES.length, `${auditorTurns} auditor, ${accountantTurns} accountant`);

  // ---- the two claims the review flagged as uncited ----
  const invoice49 = SAMPLES.find((s) => formatSampleId(s.ref) === "invoice:49");
  check("invoice:49 is present in the mock run", Boolean(invoice49));
  if (invoice49) {
    const bundles = invoice49.turns.map((t) => turnBundle(invoice49, t, tables));
    const paid = bundles.some((b) => b.citations.some((c) => c.table === "bank_transactions" && c.id === 287));
    check("invoice:49 cites the bank payment behind the \"it was paid\" claim", paid, "bank_transactions#287");
    const date = bundles
      .flatMap((b) => b.citations)
      .find((c) => c.table === "bank_transactions" && c.id === 287 && c.field === "date");
    check(
      "the settlement date in the prose is the date on that bank row",
      Boolean(date && date.value.length > 0 && invoice49.turns.some((t) => t.content.includes(date.value))),
      date ? `date = ${date.value}` : "missing",
    );
  }

  const invoice41 = SAMPLES.find((s) => formatSampleId(s.ref) === "invoice:41");
  check("invoice:41 is present in the mock run", Boolean(invoice41));
  if (invoice41) {
    const accountant = invoice41.turns.find((t) => t.role === "accountant");
    check("invoice:41 has an accountant turn", Boolean(accountant));
    if (accountant) {
      const bundle = turnBundle(invoice41, accountant, tables);
      check(
        "invoice:41 cites invoices.approved_by behind the approver claim",
        hasCitation(bundle, "invoices", 41, "approved_by"),
      );
      const approver = bundle.citations.find((c) => c.table === "invoices" && c.field === "approved_by");
      check(
        "the approver named in the prose matches the database value",
        Boolean(approver && approver.value.length > 0 && accountant.content.includes(approver.value)),
        approver ? `approved_by = ${approver.value}` : "missing",
      );
    }
  }

  // ---- a deliberately bad turn must be rejected, so the check has teeth ----
  const probeBundle: EvidenceBundle = { sample: { type: "invoice", id: 1 }, citations: [], gaps: [] };
  const uncited = validateDefense("The invoice was paid in full on 2025-01-24 for $18,500.00.", probeBundle);
  check("an uncited factual sentence is rejected by the validator", !uncited.ok, uncited.ok ? "accepted" : uncited.reason);

  const inventedBundle = turnBundle(SAMPLES[0], SAMPLES[0].turns[1], tables);
  const invented = validateDefense("The payment cleared on 2025-03-24 [invoices#99999].", inventedBundle);
  check("a citation naming a row outside the bundle is rejected", !invented.ok, invented.ok ? "accepted" : invented.reason);

  console.log(`\n${turnsChecked} turns, ${sentencesChecked} sentences validated.`);
}

main()
  .then(async () => {
    const { sql } = await import("@/db");
    await sql.end();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("All referee citation checks passed.");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    const { sql } = await import("@/db");
    await sql.end().catch(() => {});
    process.exit(1);
  });
