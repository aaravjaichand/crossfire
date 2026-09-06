/**
 * pnpm binder:check
 *
 * The binder is the artefact a reviewer signs, so what is checked here is that
 * it cannot quietly say less than the run did: every sample gets a workpaper,
 * every exception reaches the fix list with a remedy and an entry, and a gap
 * nobody has ruled on is reported as outstanding rather than dropped.
 *
 * The fixture is a hand-built RunView, so nothing here needs a database.
 */
import "./load-env";
import { buildBinder } from "./assemble";
import type { EvidenceBundle, Gap } from "@/lib/referee/evidence-types";
import type { RunView, SampleView } from "@/lib/referee/data";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function bundle(gaps: Gap[], citations: EvidenceBundle["citations"] = []): EvidenceBundle {
  return {
    sample: { type: "invoice", id: 1 },
    citations,
    gaps,
    defense: "…",
  } as EvidenceBundle;
}

type SampleInput = {
  id: string;
  label: string;
  amount: string;
  status: SampleView["status"];
  gaps?: Gap[];
  citations?: EvidenceBundle["citations"];
  procedure?: string;
  ruling?: SampleView["ruling"];
};

/** The sample key's prefix is an abbreviation; SampleView.type is not. */
const TYPE_BY_PREFIX: Record<string, SampleView["type"]> = {
  invoice: "invoice",
  bank: "bank_transaction",
  dodo: "dodo_transaction",
};

function sample(input: SampleInput): SampleView {
  return {
    id: input.id,
    type: TYPE_BY_PREFIX[input.id.split(":")[0]],
    label: input.label,
    amount: input.amount,
    date: "2025-06-30",
    status: input.status,
    ruling: input.ruling,
    thread: [
      {
        turn: 1,
        role: "auditor",
        content: `Support this item [${input.id}].`,
        procedure: input.procedure,
      },
      {
        turn: 1,
        role: "accountant",
        content: "Answer.",
        evidence: bundle(input.gaps ?? [], input.citations ?? []),
      },
    ],
  };
}

const run: RunView = {
  id: "7",
  name: "Fixture run",
  kind: "real",
  materiality: 5_000_000,
  sampleSize: 5,
  cycles: ["purchases", "cash"],
  samples: [
    sample({
      id: "invoice:1",
      label: "Vendor A · INV-1",
      amount: "1200.00",
      status: "defended",
      procedure: "three_way_match",
    }),
    sample({
      id: "invoice:2",
      label: "Vendor B · INV-2",
      amount: "9000.00",
      status: "gap",
      procedure: "approval_control",
      gaps: [{ kind: "missing_approval", description: "no approver on the invoice" }],
      ruling: { verdict: "exception", remedy: "fix_control", note: "Approval never obtained.", at: new Date() },
    }),
    sample({
      id: "bank:3",
      label: "Vendor C · WIRE-3",
      amount: "-42000.00",
      status: "gap",
      procedure: "bank_rec",
      gaps: [{ kind: "no_matching_invoice", description: "no invoice behind this payment" }],
    }),
    sample({
      id: "dodo:4",
      label: "Dodo payout · po_4",
      amount: "300.00",
      status: "defended",
      procedure: "revenue_tie_out",
      gaps: [{ kind: "payout_mismatch", description: "a difference of $412.60 against the month" }],
      ruling: { verdict: "accepted_with_note", remedy: null, note: "Below the threshold.", at: new Date() },
    }),
    sample({ id: "invoice:5", label: "Vendor E · INV-5", amount: "500.00", status: "open" }),
  ],
};

const binder = buildBinder(run, { seed: 1, startedAt: new Date("2026-09-06T12:00:00Z") });

// ---- every sample is a workpaper, in order ----
check("one workpaper per sample", binder.sections.length === run.samples.length, `${binder.sections.length}`);
check(
  "workpaper references run W-1..W-n in sample order",
  binder.sections.every((s, i) => s.ref === `W-${i + 1}` && s.sampleId === run.samples[i].id),
  binder.sections.map((s) => s.ref).join(" "),
);

// ---- procedure and assertion ----
const w1 = binder.sections[0];
check("the procedure is named, not slugged", w1.procedure === "Three-way match", w1.procedure);
check("the assertion comes from the procedure", w1.assertion.startsWith("Occurrence and accuracy"), w1.assertion);
const w5 = binder.sections[4];
check(
  "a sample with no procedure says so rather than inventing one",
  w5.procedure === "Not recorded" && w5.assertion === "Not recorded",
  `${w5.procedure} / ${w5.assertion}`,
);

// ---- proposed entries ----
check("a clean defended sample has no proposed entry", w1.entry === undefined);
check(
  "every sample with a gap has a proposed entry with both sides and a memo",
  binder.sections
    .filter((s) => s.gaps.length > 0)
    .every((s) => Boolean(s.entry?.debit && s.entry?.credit && s.entry?.memo)),
);
check(
  "the entry is keyed by the gap kind",
  binder.sections[1].entry?.gapKind === "missing_approval",
  binder.sections[1].entry?.gapKind,
);

// ---- tickmarks ----
check(
  "tickmarks: ✕ exception, △ unruled gap, ✓ defended, ○ open",
  binder.sections[1].tickmark === "✕" &&
    binder.sections[2].tickmark === "△" &&
    binder.sections[0].tickmark === "✓" &&
    binder.sections[4].tickmark === "○",
  binder.sections.map((s) => s.tickmark).join(""),
);

// ---- disposition names the decider ----
check(
  "a ruled sample's disposition says the controller ruled it",
  binder.sections[1].disposition.includes("controller") && binder.sections[1].disposition.includes("Exception"),
  binder.sections[1].disposition,
);
check(
  "an unruled gap's disposition says it is not yet ruled",
  binder.sections[2].disposition.includes("not yet ruled"),
  binder.sections[2].disposition,
);

// ---- the fix list ----
check("only ruled exceptions are on the fix list", binder.fixList.length === 1, `${binder.fixList.length}`);
check("the exception carries its remedy", binder.fixList[0]?.remedyLabel === "Fix control", binder.fixList[0]?.remedyLabel);
check("the controller's note travels with it", binder.fixList[0]?.note === "Approval never obtained.");
check(
  "an unruled gap is reported as outstanding, not dropped and not a finding",
  binder.awaiting.length === 1 && binder.awaiting[0].sampleId === "bank:3",
  binder.awaiting.map((i) => i.sampleId).join(" "),
);
check(
  "accepted_with_note is neither a finding nor outstanding work",
  !binder.fixList.some((i) => i.sampleId === "dodo:4") &&
    !binder.awaiting.some((i) => i.sampleId === "dodo:4"),
);
check(
  "an amount is ranked by the entry, and a payment's sign never makes it negative",
  binder.awaiting[0].amountCents === 4_200_000,
  String(binder.awaiting[0].amountCents),
);

// ---- ranking and totals ----
const many = buildBinder({
  ...run,
  samples: [500, 12_000, 90, 12_000].map((amount, i) =>
    sample({
      id: `invoice:${100 + i}`,
      label: `Vendor ${i}`,
      amount: `${amount}.00`,
      status: "gap",
      procedure: "cutoff",
      gaps: [{ kind: "other", description: "unsupported" }],
      ruling: { verdict: "exception", remedy: "post_entry", note: null, at: new Date() },
    }),
  ),
});
check(
  "the fix list is ranked by amount, largest first, ties by workpaper",
  many.fixList.map((i) => `${i.ref}:${i.amountCents}`).join(" ") ===
    "W-2:1200000 W-4:1200000 W-1:50000 W-3:9000",
  many.fixList.map((i) => `${i.ref}:${i.amountCents}`).join(" "),
);
check(
  "the fix-list total is the sum of its items",
  many.totals.fixListCents === many.fixList.reduce((n, i) => n + i.amountCents, 0),
  String(many.totals.fixListCents),
);

// ---- cover sheet ----
check("the cover sheet carries the run inputs", binder.run.seed === 1 && binder.run.materiality === 5_000_000);
check(
  "coverage counts defended samples out of every sample",
  binder.coverage.total === 5 && binder.coverage.defended === 2 && binder.coverage.percent === 40,
  `${binder.coverage.defended}/${binder.coverage.total} = ${binder.coverage.percent}%`,
);
check(
  "the counts on the cover sheet match the lists below it",
  binder.counts.exceptions === binder.fixList.length &&
    binder.counts.awaiting === binder.awaiting.length &&
    binder.counts.open === 1,
);

console.log(failures === 0 ? "\nAll binder checks passed." : `\n${failures} binder check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
