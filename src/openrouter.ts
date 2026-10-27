import { loadConfig, loadOpenRouterKey } from "./config.ts";
import { appendUsage, type Purpose, type UsageEntry } from "./usage.ts";

// Shared OpenRouter chat-completions client — the single connector both the
// generator and the jury run through, authenticated by OPENROUTER_API_KEY.
// Supports plain single-shot calls (the jury) and multi-turn tool calling
// (the generator's agent loop, see agentloop.ts). Every call — successful or
// not — is appended to the usage ledger (usage.ts), tagged with its purpose.

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Provider-reported cost in USD (OpenRouter credits), when available. */
  costUsd?: number;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  /** For role:"tool" — which call this message answers. */
  tool_call_id?: string;
}

/** OpenAI-style function tool definition. */
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatTurnOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Ask for response_format json_object (for the jury's structured verdict). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** What the call is for — tags the usage ledger (untagged = "other"). */
  purpose?: Purpose;
  /** Groups the calls of one generation or one jury panel in the ledger. */
  run?: string;
}

export interface ChatTurnResult {
  message: ChatMessage;
  usage: Usage;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Where the usage ledger is written; injectable so tests never touch logs/.
let ledgerPath: () => string = () => loadConfig().abs.usage;
export function setLedgerPath(fn: () => string): void {
  ledgerPath = fn;
}

/** One request/response exchange; the caller owns the message history. */
export async function chatTurn(opts: ChatTurnOptions): Promise<ChatTurnResult> {
  const key = loadOpenRouterKey();
  const cfg = loadConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  // Optional attribution headers (https://openrouter.ai/docs/app-attribution)
  if (cfg.openrouter.referer) headers["HTTP-Referer"] = cfg.openrouter.referer;
  headers["X-Title"] = cfg.openrouter.title || cfg.name;

  const started = Date.now();
  const ledger = (fields: Partial<UsageEntry> & Pick<UsageEntry, "ok">): void => {
    let path: string;
    try {
      path = ledgerPath();
    } catch {
      return; // telemetry never fails a call
    }
    appendUsage(path, {
      at: new Date().toISOString(),
      purpose: opts.purpose ?? "other",
      model: opts.model,
      ...(opts.run ? { run: opts.run } : {}),
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      ms: Date.now() - started,
      ...fields,
    });
  };

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        // Ask OpenRouter to report the real cost of this call in the usage block.
        usage: { include: true },
      }),
    });
  } catch (err) {
    ledger({ ok: false, error: (err as Error).message.slice(0, 300) });
    throw err;
  }
  if (!res.ok) {
    const error = `OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`;
    ledger({ ok: false, error });
    throw new Error(error);
  }
  let data: {
    id?: string;
    provider?: string;
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    ledger({ ok: false, error: `unreadable response: ${(err as Error).message}`.slice(0, 300) });
    throw err;
  }
  const usage: Usage = {
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    ...(typeof data.usage?.cost === "number" ? { costUsd: data.usage.cost } : {}),
  };
  const raw = data.choices?.[0]?.message;
  // A message with neither text nor tool calls is a failed call for the
  // record, even though the agent loop may recover from it with a reminder.
  const empty = Boolean(raw) && !raw!.content && !raw!.tool_calls?.length;
  ledger({
    ok: Boolean(raw) && !empty,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    costUsd: usage.costUsd ?? null,
    ...(data.provider ? { provider: data.provider } : {}),
    ...(data.id ? { generationId: data.id } : {}),
    ...(raw ? (empty ? { error: "OpenRouter returned an empty message" } : {}) : { error: "OpenRouter returned no message" }),
  });
  if (!raw) throw new Error("OpenRouter returned no message");
  return {
    message: {
      role: "assistant",
      content: raw.content ?? null,
      ...(raw.tool_calls?.length ? { tool_calls: raw.tool_calls } : {}),
    },
    usage,
  };
}

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  purpose?: Purpose;
  run?: string;
}

export interface ChatResult {
  content: string;
  usage: Usage;
}

/** Single system+user exchange returning text content (the jury's shape). */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const { message, usage } = await chatTurn({
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    json: opts.json,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    purpose: opts.purpose,
    run: opts.run,
  });
  if (!message.content) throw new Error("OpenRouter returned no content");
  return { content: message.content, usage };
}
