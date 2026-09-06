/**
 * The binder, assembled from the run. No model call, no judgement of its own:
 * every line on the printed page is a row that already exists — an exchange,
 * a citation, a controller ruling, or an entry from the fixed adjustment table
 * keyed by gap kind.
 *
 * Two things this file is careful about, because both under-report findings if
 * they are got wrong:
 *
 *   - An exception verdict leaves audit_samples.status at "gap". Status alone
 *     cannot tell a finding the controller has ruled on from one still waiting
 *     for a ruling, so the fix list is built from the verdict and split into
 *     two groups. A gap with no ruling is outstanding work, and saying so is
 *     the honest thing for a binder to do.
 *   - proposeAdjustment always returns an entry, falling back to the sampled
 *     row's own amount when the citations do not support the rule it wanted.
 *     That fallback is carried through as `fellBack` so the page never presents
 *     a fallen-back figure as a computed variance.
 */
import { toCents } from "@/lib/accountant/money";
import { proposeAdjustment, type ProposedEntry } from "@/lib/referee/adjustments";
import {
  coverage,
  formatMoney,
  latestEvidence,
  parseSampleId,
  primaryGap,
  type MessageView,
  type RunView,
  type Ruling,
  type SampleStatus,
  type SampleView,
} from "@/lib/referee/data";
import type { Citation, Gap } from "@/lib/referee/evidence-types";
import { REMEDY_LABEL, VERDICT_LABEL } from "@/lib/referee/verdicts";
import { assertionFor, procedureName } from "./assertions";

export const COMPANY = "Northwind Labs, Inc.";
export const PERIOD = "FY2025 — year ended 31 December 2025";
export const CONTROLLER = "Controller, Northwind Labs";

export type BinderSection = {
  /** 1-based, and the workpaper reference: W-1, W-2, ... */
  index: number;
  ref: string;
  /** "invoice:15" — the sampled row. */
  sampleId: string;
  label: string;
  amount: string;
  date: string;
  procedure: string;
  assertion: string;
  status: SampleStatus;
  thread: MessageView[];
  citations: Citation[];
  gaps: Gap[];
  ruling?: Ruling;
  /** One sentence: what happened to this sample and who decided it. */
  disposition: string;
  /** The tickmark printed beside the disposition. See TICKMARKS. */
  tickmark: string;
  /** Present whenever the sample carries a gap or was ruled an exception. */
  entry?: ProposedEntry;
};

export type FixItem = {
  ref: string;
  sampleId: string;
  label: string;
  amountCents: number;
  amount: string;
  gapKind: string;
  gapDescription: string;
  remedyLabel?: string;
  note?: string;
  entry: ProposedEntry;
};

export type BinderView = {
  company: string;
  period: string;
  controller: string;
  run: {
    id: string;
    name: string;
    kind: "mock" | "real";
    /** From audit_runs; RunView does not carry it. */
    seed?: number;
    startedAt?: Date;
    materiality?: number;
    sampleSize?: number;
    cycles?: string[];
  };
  coverage: { defended: number; total: number; percent: number };
  counts: { exceptions: number; awaiting: number; open: number };
  sections: BinderSection[];
  /** Exceptions the controller has ruled on, largest first. */
  fixList: FixItem[];
  /** Gaps that reached the controller and have not been ruled on, largest first. */
  awaiting: FixItem[];
  totals: { fixListCents: number; awaitingCents: number };
};

/** The legend printed at the foot of the binder. */
export const TICKMARKS: { mark: string; meaning: string }[] = [
  { mark: "✓", meaning: "Vouched. Evidence agreed to the supporting document and the ledger." },
  {
    mark: "◆",
    meaning:
      "Resolved by memory. Closed by a ruling the controller made on this counterparty in an earlier run; the ruling is quoted and cited in the exchange.",
  },
  { mark: "△", meaning: "Gap. The accountant could not support the item; escalated to the controller." },
  { mark: "✕", meaning: "Exception. The controller recorded a finding; see the fix list." },
  { mark: "○", meaning: "Open. Still with the accountant at the time this binder was printed." },
];

/**
 * The inputs that are on audit_runs but not on RunView (see run-inputs.ts),
 * plus the samples audit_samples.resolution marks as settled from run memory,
 * keyed the way SampleView ids are. That column is not on RunView either, so
 * the page reads it with memoryResolvedIds() and passes it in here.
 */
export type BinderExtras = { seed?: number; startedAt?: Date; memoryResolved?: Set<string> };

export function buildBinder(run: RunView, extras: BinderExtras = {}): BinderView {
  const sections = run.samples.map((sample, i) =>
    buildSection(sample, i + 1, extras.memoryResolved?.has(sample.id) ?? false),
  );

  const fixList: FixItem[] = [];
  const awaiting: FixItem[] = [];
  for (const section of sections) {
    if (!section.entry) continue;
    const item = toFixItem(section, section.entry);
    if (section.ruling?.verdict === "exception") fixList.push(item);
    else if (section.status === "gap" || section.status === "conceded") awaiting.push(item);
  }
  fixList.sort(byAmount);
  awaiting.sort(byAmount);

  return {
    company: COMPANY,
    period: PERIOD,
    controller: CONTROLLER,
    run: {
      id: run.id,
      name: run.name,
      kind: run.kind,
      seed: extras.seed,
      startedAt: extras.startedAt,
      materiality: run.materiality,
      sampleSize: run.sampleSize,
      cycles: run.cycles,
    },
    coverage: coverage(run),
    counts: {
      exceptions: fixList.length,
      awaiting: awaiting.length,
      open: sections.filter((s) => s.status === "open").length,
    },
    sections,
    fixList,
    awaiting,
    totals: {
      fixListCents: fixList.reduce((n, item) => n + item.amountCents, 0),
      awaitingCents: awaiting.reduce((n, item) => n + item.amountCents, 0),
    },
  };
}

function buildSection(sample: SampleView, index: number, byMemory: boolean): BinderSection {
  const evidence = latestEvidence(sample);
  const procedureId = sample.thread.find((m) => m.role === "auditor" && m.procedure)?.procedure ?? null;
  const gaps = evidence?.gaps ?? [];
  const ruledException = sample.ruling?.verdict === "exception";

  const section: BinderSection = {
    index,
    ref: `W-${index}`,
    sampleId: sample.id,
    label: sample.label,
    amount: formatMoney(sample.amount),
    date: sample.date,
    procedure: procedureName(procedureId),
    assertion: assertionFor(procedureId),
    status: sample.status,
    thread: sample.thread,
    citations: evidence?.citations ?? [],
    gaps,
    ruling: sample.ruling,
    disposition: disposition(sample, byMemory),
    tickmark: tickmark(sample, byMemory),
  };

  if (gaps.length > 0 || ruledException) {
    // The row id is read off the sample key ("invoice:15", "bank:202"), but the
    // type comes from the sample itself: the key's prefix is an abbreviation
    // ("bank", not "bank_transaction") and mixing the two is how a finding
    // silently loses its entry.
    const rowId = parseSampleId(sample.id)?.id;
    const gap = primaryGap(sample);
    if (rowId !== undefined) {
      section.entry = proposeAdjustment({
        gapKind: gap.kind,
        sampleType: sample.type,
        sampleId: rowId,
        sampleAmount: sample.amount,
        citations: section.citations,
        gapDescription: gap.description,
      });
    }
  }

  return section;
}

/** One sentence a reviewer can read on its own, naming who decided. */
function disposition(sample: SampleView, byMemory: boolean): string {
  const ruling = sample.ruling;
  if (ruling) {
    const head = `${VERDICT_LABEL[ruling.verdict]} — ruled by the controller`;
    if (ruling.verdict === "exception") {
      const remedy = ruling.remedy ? REMEDY_LABEL[ruling.remedy].toLowerCase() : "no remedy recorded";
      return `${head}. Remedy: ${remedy}. The proposed entry below is the correction.`;
    }
    if (ruling.verdict === "needs_more") {
      return `${head}. Sent back to the accountant for more evidence.`;
    }
    if (ruling.verdict === "accepted_with_note") {
      return `${head}. Accepted below the threshold worth pursuing, with the note on file.`;
    }
    return `${head}. The evidence supports the balance as filed.`;
  }
  // Checked after a ruling made on this run, which is the later judgement and
  // must not be overwritten by one carried forward.
  if (byMemory) {
    return "Resolved by memory — closed by the controller's ruling on this counterparty in an earlier run, quoted and cited in the exchange above. No new ruling was required.";
  }
  if (sample.status === "defended") {
    return "Defended — the auditor's follow-up policy accepted the evidence; no controller ruling was required.";
  }
  if (sample.status === "gap") {
    return "Gap — the accountant admitted the item is not fully supported. Escalated to the controller, not yet ruled.";
  }
  if (sample.status === "conceded") {
    return "Conceded — recorded as a finding by an earlier run.";
  }
  return "Open — still with the accountant when this binder was printed.";
}

function tickmark(sample: SampleView, byMemory: boolean): string {
  if (sample.ruling?.verdict === "exception") return "✕";
  if (byMemory) return "◆";
  if (sample.status === "defended") return "✓";
  if (sample.status === "gap") return "△";
  if (sample.status === "conceded") return "✕";
  return "○";
}

function toFixItem(section: BinderSection, entry: ProposedEntry): FixItem {
  const gap = section.gaps[0];
  return {
    ref: section.ref,
    sampleId: section.sampleId,
    label: section.label,
    // The entry's own figure, which is what would be booked — not the sampled
    // row's amount, which for a rate variance is the whole invoice.
    amountCents: Math.abs(toCents(entry.amount.replace(/[$,\s]/g, ""))),
    amount: entry.amount,
    gapKind: entry.gapKind,
    gapDescription: gap?.description ?? "",
    remedyLabel: section.ruling?.remedy ? REMEDY_LABEL[section.ruling.remedy] : undefined,
    note: section.ruling?.note ?? undefined,
    entry,
  };
}

/** Largest first; ties broken by workpaper reference so the order is stable. */
function byAmount(a: FixItem, b: FixItem): number {
  if (b.amountCents !== a.amountCents) return b.amountCents - a.amountCents;
  return a.ref.localeCompare(b.ref, "en", { numeric: true });
}
