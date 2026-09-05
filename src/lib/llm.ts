/**
 * The only place Crossfire talks to a model. Search and matching are plain code;
 * the model reads gathered evidence and writes prose, nothing else.
 */
import OpenAI from "openai";

export const LLM_BASE_URL = "https://api.tensormux.com/v1";
export const LLM_MODEL = "glm-4-7-flash";
export const LLM_TIMEOUT_MS = 30_000;

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.TENSORMUX_API_KEY,
      baseURL: LLM_BASE_URL,
      timeout: LLM_TIMEOUT_MS,
      // One sample, one HTTP request. A retry would be a second call the
      // referee never asked for, so a failed call fails loudly instead.
      maxRetries: 0,
    });
  }
  return client;
}

/** One chat completion at temperature 0. Returns the message text. */
export async function complete(system: string, user: string): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: LLM_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error(`${LLM_MODEL} returned an empty completion.`);
  return text;
}
