/**
 * pnpm auditor:check-citation
 *
 * Deterministic, free (no LLM, no DB): asserts that withSampleCitation()
 * guarantees a valid "[table#id]" citation for the sampled row regardless
 * of what the "model" (a plain string stand-in here) returned — including
 * adversarial cases where the model cites a *different* row, cites nothing,
 * or already cites the right one. The citation is always added by code,
 * never requested from or trusted to the model.
 */
import { sampleCitation, withSampleCitation, type CitableSample } from "./citation";

type Case = { name: string; sample: CitableSample; modelText: string };

const cases: Case[] = [
  {
    name: "bank_transaction: model text has no citation at all",
    sample: { sampleType: "bank_transaction", sampleId: 20 },
    modelText: "Could you show me the invoice for this $18,500.00 payment to Stratus Compute Inc.?",
  },
  {
    name: "invoice: model text already cites the correct row",
    sample: { sampleType: "invoice", sampleId: 5 },
    modelText: "Can you provide the contract clause authorizing this rate? [invoices#5]",
  },
  {
    name: "dodo_transaction: model text cites a different, wrong row (adversarial)",
    sample: { sampleType: "dodo_transaction", sampleId: 340 },
    modelText: "Show the composition of this payout. [dodo_transactions#317]",
  },
  {
    name: "bank_transaction: empty model text (total failure)",
    sample: { sampleType: "bank_transaction", sampleId: 3 },
    modelText: "",
  },
  {
    name: "invoice: model text ends without punctuation",
    sample: { sampleType: "invoice", sampleId: 9 },
    modelText: "Show the approval for this invoice",
  },
];

let failures = 0;
for (const c of cases) {
  const expected = sampleCitation(c.sample);
  const result = withSampleCitation(c.modelText, c.sample);
  const hasExpected = result.includes(expected);
  // The adversarial case must not be satisfied by the wrong citation alone:
  // confirm the *correct* one is present even though a different one was too.
  const ok = hasExpected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      expected citation ${expected} present=${hasExpected}`);
  console.log(`      stored: "${result}"`);
}

// Idempotence: running it twice must not duplicate the citation.
{
  const sample: CitableSample = { sampleType: "invoice", sampleId: 5 };
  const once = withSampleCitation("Some question.", sample);
  const twice = withSampleCitation(once, sample);
  const ok = once === twice && twice.split(sampleCitation(sample)).length === 2;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  idempotent: applying twice does not duplicate the citation`);
  console.log(`      once="${once}" twice="${twice}"`);
}

if (failures > 0) {
  console.error(`\n${failures} of ${cases.length + 1} case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length + 1} cases passed.`);
