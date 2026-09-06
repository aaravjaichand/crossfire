/**
 * The only place Crossfire talks to a model. Search and matching are plain code;
 * the model reads gathered evidence and writes prose, nothing else.
 */
import OpenAI from "openai";

export const LLM_BASE_URL = "https://api.tensormux.com/v1";
export const LLM_MODEL = "glm-4-7-flash";
export const LLM_TIMEOUT_MS = 30_000;

/**
 * GLM-4.x thinks before it answers, and the proxy bills the thinking as
 * completion tokens without ever returning it: a 480-character defense arrived
 * as ~680 completion tokens, ~2 of which were visible, taking 14-21 seconds.
 * Capping max_tokens made it worse — the cap was spent on hidden reasoning and
 * the message came back empty with finish_reason "length".
 *
 * Two request fields turn the thinking off at the backend, measured against
 * https://api.tensormux.com/v1/chat/completions with the real defense prompt:
 * 681 -> 106 completion tokens, 7.1s -> 1.2s, same answer, same citations.
 * `thinking: { type: "disabled" }` and `extra_body` are forwarded but ignored,
 * so neither is used here.
 *
 * `reasoning_effort` is standard and sits in the typed params below. This one
 * is not in the OpenAI schema, so it is not in the SDK's types either; the
 * proxy forwards it regardless. Both are sent because either alone is enough:
 * if the proxy stops honouring one the other still keeps the demo fast, and if
 * it honours neither the call is merely slow again, never wrong.
 */
const NO_THINKING_EXTRA = { chat_template_kwargs: { enable_thinking: false } };

/**
 * Room for any answer the prompts can ask for — the real defenses land near
 * 110 tokens. This is a guard against a runaway generation, not a budget, so
 * it is set well clear of the work rather than close to it.
 */
export const LLM_MAX_TOKENS = 4096;

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
    reasoning_effort: "none",
    max_tokens: LLM_MAX_TOKENS,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...NO_THINKING_EXTRA,
  });
  const choice = response.choices[0];
  const text = choice?.message?.content?.trim();
  // A truncated answer would be a half sentence shown to a referee, so it is
  // treated as a failed call: the caller falls back to assembled prose.
  if (choice?.finish_reason === "length") {
    throw new Error(`${LLM_MODEL} hit the ${LLM_MAX_TOKENS}-token cap before finishing.`);
  }
  if (!text) throw new Error(`${LLM_MODEL} returned an empty completion.`);
  return text;
}
