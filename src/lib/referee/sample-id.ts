import type { SampleRef, SampleType } from "./evidence-types";

// "invoice:5", "bank:202", "dodo:340" — the same strings the CLIs accept.
const PREFIX: Record<SampleType, string> = {
  invoice: "invoice",
  bank_transaction: "bank",
  dodo_transaction: "dodo",
};

const TYPE_BY_PREFIX: Record<string, SampleType> = {
  invoice: "invoice",
  bank: "bank_transaction",
  dodo: "dodo_transaction",
};

export function formatSampleId(ref: SampleRef): string {
  return `${PREFIX[ref.type]}:${ref.id}`;
}

export function parseSampleId(value: string): SampleRef | null {
  const [prefix, rawId, extra] = value.split(":");
  if (extra !== undefined) return null;
  const type = TYPE_BY_PREFIX[prefix ?? ""];
  const id = Number(rawId);
  if (!type || !Number.isInteger(id) || id <= 0) return null;
  return { type, id };
}

export function isSampleType(value: string): value is SampleType {
  return value === "invoice" || value === "bank_transaction" || value === "dodo_transaction";
}
