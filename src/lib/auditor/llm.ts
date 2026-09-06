// LLM client for the auditor agent. Exactly one call per sample: rephrase
// the deterministically-chosen question template into a natural sentence.
// The model never chooses facts, templates, or citations, only prose.
//
// Uses the shared client (src/lib/llm.ts): one HTTP request, no retries, a
// bounded 30s timeout. Falls back to the template text on any error so a
// slow or failed model call never blocks a run.
import { llmDisabled, llmForcedToFail } from "@/lib/accountant";
import { complete, LLM_MODEL } from "@/lib/llm";
import { traceLlmCall } from "@/lib/tracing";

const SYSTEM_PROMPT =
  "You are an auditor opening a conversation with a company's accountant about one sampled transaction. " +
  "Rephrase the given question naturally and concisely, in one or two sentences. " +
  "Keep every number, date, name, and identifier from the original exactly as written: do not round amounts, " +
  "invent facts, or drop identifiers. Reply with only the question, no preamble.";

/**
 * Rephrases `templateText` (already filled with sample facts) into a
 * natural-sounding auditor question. Falls back to `templateText` itself if
 * the API call errors (or the model is turned off), logging the failure.
 */
export async function phraseQuestion(templateText: string): Promise<string> {
  // CROSSFIRE_NO_LLM=1 runs the whole product on the deterministic templates.
  if (llmDisabled()) return templateText;
  try {
    if (llmForcedToFail()) {
      throw new Error("[auditor probe] simulated model failure (CROSSFIRE_LLM_FAIL)");
    }
    // Timed and filed under the sample's span when a run is on the stack;
    // otherwise a plain call. Errors still fall through to the template.
    return await traceLlmCall(
      { name: "auditor.question", model: LLM_MODEL, input: templateText },
      () => complete(SYSTEM_PROMPT, templateText),
    );
  } catch (err) {
    console.error(
      `[auditor/llm] LLM call failed, falling back to template text: ${err instanceof Error ? err.message : String(err)}`,
    );
    return templateText;
  }
}
