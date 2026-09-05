import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleRef, SampleType } from "./evidence-types";
import type { MessageRole, MessageView, RunView, SampleStatus, SampleView } from "./data";
import { bankLabel, dodoLabel, invoiceLabel } from "./labels";
import { parseEvidenceBundle } from "./parse-evidence";
import { formatSampleId, isSampleType } from "./sample-id";

// Loads a run the auditor actually persisted.
//
// The two ids on audit_samples are easy to confuse and mean different things:
//   - audit_samples.id        the conversation row. audit_exchanges.sample_id
//                             is an FK to this, and it is what carries status.
//   - audit_samples.sample_id the underlying bank_transactions / invoices /
//                             dodo_transactions row. This is what the URL and
//                             referee_decisions.sample_id refer to.
// Nothing below may swap one for the other.

const STATUSES = new Set<string>(["open", "defended", "gap", "conceded"]);

export type RealSample = {
  auditSampleId: number;
  ref: SampleRef;
};

export async function buildRealRun(runDbId: number): Promise<RunView | null> {
  const [run] = await db
    .select()
    .from(schema.auditRuns)
    .where(eq(schema.auditRuns.id, runDbId));
  if (!run) return null;

  const sampleRows = await db
    .select()
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.runId, run.id))
    .orderBy(asc(schema.auditSamples.id));

  const exchangeRows = sampleRows.length
    ? await db
        .select()
        .from(schema.auditExchanges)
        .where(eq(schema.auditExchanges.runId, run.id))
        .orderBy(asc(schema.auditExchanges.turn), asc(schema.auditExchanges.id))
    : [];

  // Keyed by audit_samples.id, which is what audit_exchanges.sample_id holds.
  const threads = new Map<number, MessageView[]>();
  for (const row of exchangeRows) {
    const role = messageRole(row.role);
    if (!role) continue;
    const message: MessageView = { turn: row.turn, role, content: row.content };
    const evidence = row.evidence === null ? undefined : parseEvidenceBundle(row.evidence);
    if (evidence) message.evidence = evidence;
    const list = threads.get(row.sampleId);
    if (list) list.push(message);
    else threads.set(row.sampleId, [message]);
  }

  const usable = sampleRows.filter((row) => isSampleType(row.sampleType));
  const sources = await loadSourceRows(usable.map((r) => ({ type: r.sampleType as SampleType, id: r.sampleId })));

  const samples: SampleView[] = [];
  for (const row of usable) {
    const ref: SampleRef = { type: row.sampleType as SampleType, id: row.sampleId };
    const id = formatSampleId(ref);
    const source = sources.get(id);
    samples.push({
      id,
      auditSampleId: row.id,
      type: ref.type,
      // A sample whose underlying row has since disappeared still belongs in
      // the list; it just cannot be described from the source tables.
      label: source?.label ?? `${ref.type} ${ref.id} (source row missing)`,
      amount: source?.amount ?? row.amount,
      date: source?.date ?? "",
      status: STATUSES.has(row.status) ? (row.status as SampleStatus) : "open",
      thread: threads.get(row.id) ?? [],
    });
  }

  return { id: String(run.id), name: run.name, kind: "real", samples };
}

/**
 * Resolves a sample to its audit_samples.id within one run, or null when the
 * run does not contain it. Matching on run + type + underlying sample_id is
 * what stops a decision aimed at one run from landing on another run's row.
 */
export async function findRealSample(
  runDbId: number,
  ref: SampleRef,
): Promise<RealSample | null> {
  const [match] = await db
    .select({ id: schema.auditSamples.id })
    .from(schema.auditSamples)
    .where(
      and(
        eq(schema.auditSamples.runId, runDbId),
        eq(schema.auditSamples.sampleType, ref.type),
        eq(schema.auditSamples.sampleId, ref.id),
      ),
    )
    .orderBy(asc(schema.auditSamples.id));

  if (!match) return null;
  return { auditSampleId: match.id, ref };
}

export async function realRunExists(runDbId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.auditRuns.id })
    .from(schema.auditRuns)
    .where(eq(schema.auditRuns.id, runDbId));
  return Boolean(row);
}

function messageRole(role: string): MessageRole | null {
  if (role === "auditor" || role === "accountant" || role === "referee") return role;
  return null;
}

type SourceRow = { label: string; date: string; amount: string };

/** Labels, dates, and amounts come from the seeded source tables, not from the
 * denormalised copy on audit_samples. */
async function loadSourceRows(refs: SampleRef[]): Promise<Map<string, SourceRow>> {
  const out = new Map<string, SourceRow>();
  const invoiceIds = refs.filter((r) => r.type === "invoice").map((r) => r.id);
  const bankIds = refs.filter((r) => r.type === "bank_transaction").map((r) => r.id);
  const dodoIds = refs.filter((r) => r.type === "dodo_transaction").map((r) => r.id);

  const [invoices, banks, dodos] = await Promise.all([
    invoiceIds.length
      ? db.select().from(schema.invoices).where(inArray(schema.invoices.id, invoiceIds))
      : [],
    bankIds.length
      ? db
          .select()
          .from(schema.bankTransactions)
          .where(inArray(schema.bankTransactions.id, bankIds))
      : [],
    dodoIds.length
      ? db
          .select()
          .from(schema.dodoTransactions)
          .where(inArray(schema.dodoTransactions.id, dodoIds))
      : [],
  ]);

  const vendorIds = [...new Set(invoices.map((i) => i.vendorId))];
  const vendors = vendorIds.length
    ? await db.select().from(schema.vendors).where(inArray(schema.vendors.id, vendorIds))
    : [];
  const vendorNames = new Map(vendors.map((v) => [v.id, v.name]));

  for (const row of invoices) {
    out.set(formatSampleId({ type: "invoice", id: row.id }), {
      label: invoiceLabel(vendorNames.get(row.vendorId) ?? `vendor #${row.vendorId}`, row.invoiceNumber),
      date: row.issueDate,
      amount: row.amount,
    });
  }
  for (const row of banks) {
    out.set(formatSampleId({ type: "bank_transaction", id: row.id }), {
      label: bankLabel(row.counterparty, row.reference),
      date: row.date,
      amount: row.amount,
    });
  }
  for (const row of dodos) {
    out.set(formatSampleId({ type: "dodo_transaction", id: row.id }), {
      label: dodoLabel(row.type, row.reference),
      date: row.date,
      amount: row.amount,
    });
  }
  return out;
}
