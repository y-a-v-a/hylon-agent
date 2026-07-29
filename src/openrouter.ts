import { loadConfig, loadOpenRouterKey } from "./config.ts";

// Shared OpenRouter chat-completions client — the single connector both the
// generator and the jury run through, authenticated by OPENROUTER_API_KEY.

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Provider-reported cost in USD (OpenRouter credits), when available. */
  costUsd?: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
}

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  /** Ask for response_format json_object (for the jury's structured verdict). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const key = loadOpenRouterKey();
  const cfg = loadConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  // Optional attribution headers (https://openrouter.ai/docs/app-attribution)
  if (cfg.openrouter.referer) headers["HTTP-Referer"] = cfg.openrouter.referer;
  headers["X-Title"] = cfg.openrouter.title || cfg.name;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      // Ask OpenRouter to report the real cost of this call in the usage block.
      usage: { include: true },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return {
    content,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      ...(typeof data.usage?.cost === "number" ? { costUsd: data.usage.cost } : {}),
    },
  };
}
