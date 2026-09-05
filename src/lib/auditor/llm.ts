// LLM client for the auditor agent. Exactly one call per sample: rephrase
// the deterministically-chosen question template into a natural sentence.
// The model never chooses facts or templates, only prose.
//
// TODO: switch to src/lib/llm.ts once Worker A's PR merges (same client,
// shared across agents).
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.tensormux.com/v1",
  apiKey: process.env.TENSORMUX_API_KEY,
});

const MODEL = "glm-4-7-flash";

/**
 * Rephrases `templateText` (already filled with sample facts) into a
 * natural-sounding auditor question. Falls back to `templateText` itself if
 * the API call errors, logging the failure.
 */
export async function phraseQuestion(templateText: string): Promise<string> {
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are an auditor opening a conversation with a company's accountant about one sampled transaction. " +
            "Rephrase the given question naturally and concisely, in one or two sentences. " +
            "Keep every number, date, name, and identifier from the original exactly as written: do not round amounts, " +
            "invent facts, or drop identifiers. Reply with only the question, no preamble.",
        },
        { role: "user", content: templateText },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) throw new Error("empty completion");
    return text;
  } catch (err) {
    console.error(
      `[auditor/llm] LLM call failed, falling back to template text: ${err instanceof Error ? err.message : String(err)}`,
    );
    return templateText;
  }
}
