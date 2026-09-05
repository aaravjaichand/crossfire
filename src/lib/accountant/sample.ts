import type { SampleRef, SampleType } from "./types";

const PREFIX_TO_TYPE: Record<string, SampleType> = {
  bank: "bank_transaction",
  invoice: "invoice",
  dodo: "dodo_transaction",
};

const TYPE_TO_PREFIX: Record<SampleType, string> = {
  bank_transaction: "bank",
  invoice: "invoice",
  dodo_transaction: "dodo",
};

export const SAMPLE_ID_HELP = 'expected "bank:<id>", "invoice:<id>", or "dodo:<id>"';

/** "invoice:17" -> { type: "invoice", id: 17 } */
export function parseSampleId(input: string): SampleRef {
  const [prefix, rest, ...extra] = input.trim().split(":");
  const type = PREFIX_TO_TYPE[prefix?.toLowerCase() ?? ""];
  if (!type || extra.length > 0) {
    throw new Error(`Bad sample "${input}": ${SAMPLE_ID_HELP}.`);
  }
  const id = Number(rest);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Bad sample id in "${input}": ${SAMPLE_ID_HELP}.`);
  }
  return { type, id };
}

/** { type: "invoice", id: 17 } -> "invoice:17" */
export function formatSampleId(sample: SampleRef): string {
  return `${TYPE_TO_PREFIX[sample.type]}:${sample.id}`;
}
