import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  chatTurn,
  type ChatMessage,
  type ChatTurnOptions,
  type ChatTurnResult,
  type ToolCall,
  type ToolDef,
} from "./openrouter.ts";
import { resolveCostUsd } from "./cost.ts";

// A minimal file-tool agent loop over OpenRouter tool calling. This restores
// the agentic behavior vana got from the Claude Agent SDK — the model writes
// its files itself, can read them back, and self-corrects — but provider-
// agnostic: any OpenRouter model with tool support can drive it.
//
// The loop ends when the model replies without tool calls AND every required
// file exists (missing files earn a reminder and another turn), or when
// maxTurns runs out. File validation stays the caller's job.

// ── Tools (OpenAI function-calling format) ───────────────────────────────────
export const FILE_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file in the working directory. Always pass the COMPLETE file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. index.html" },
          content: { type: "string", description: "The complete file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. index.html" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the working directory (relative paths).",
      parameters: { type: "object", properties: {} },
    },
  },
];

const READ_CAP_BYTES = 256 * 1024;

// ── Sandboxed tool execution (pure-ish, testable) ────────────────────────────

/** Resolve a tool-supplied relative path inside workDir; throw on escape. */
export function resolveWorkPath(workDir: string, rel: string): string {
  const root = resolve(workDir);
  const p = resolve(root, rel);
  if (p !== root && !p.startsWith(root + sep)) {
    throw new Error(`path escapes the working directory: ${rel}`);
  }
  return p;
}

function listFilesRec(root: string, dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) listFilesRec(root, p, out);
    else out.push(relative(root, p));
  }
}

/**
 * Execute one tool call against workDir. Errors (bad path, bad args, missing
 * file) are RETURNED as an "ERROR: …" result rather than thrown, so the model
 * sees them and can correct course — that is the point of the loop.
 */
export function executeTool(workDir: string, call: ToolCall): string {
  try {
    const args = JSON.parse(call.function.arguments || "{}") as {
      path?: string;
      content?: string;
    };
    switch (call.function.name) {
      case "write_file": {
        if (!args.path || typeof args.content !== "string") {
          return "ERROR: write_file requires { path, content }";
        }
        const p = resolveWorkPath(workDir, args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content, "utf8");
        return `Wrote ${args.path} (${Buffer.byteLength(args.content, "utf8")} bytes)`;
      }
      case "read_file": {
        if (!args.path) return "ERROR: read_file requires { path }";
        const content = readFileSync(resolveWorkPath(workDir, args.path), "utf8");
        return content.length > READ_CAP_BYTES
          ? content.slice(0, READ_CAP_BYTES) + `\n…[truncated at ${READ_CAP_BYTES} bytes]`
          : content;
      }
      case "list_files": {
        const out: string[] = [];
        listFilesRec(resolve(workDir), resolve(workDir), out);
        return out.length ? out.sort().join("\n") : "(empty)";
      }
      default:
        return `ERROR: unknown tool ${call.function.name}`;
    }
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}

// ── The loop ─────────────────────────────────────────────────────────────────

export type Transport = (opts: ChatTurnOptions) => Promise<ChatTurnResult>;

export interface AgentLoopOptions {
  model: string;
  system: string;
  task: string;
  workDir: string;
  /** Files that must exist before the loop accepts a no-tool-call reply. */
  requiredFiles?: string[];
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  /** Injectable for tests; defaults to the real OpenRouter chatTurn. */
  transport?: Transport;
}

export interface AgentLoopResult {
  /** Total cost across every turn, USD. */
  costUsd: number;
  turns: number;
  /** The model's final text reply (its summary), if any. */
  finalText: string | null;
}

function missingFiles(workDir: string, required: string[]): string[] {
  return required.filter((f) => {
    try {
      return readFileSync(resolveWorkPath(workDir, f), "utf8").trim().length === 0;
    } catch {
      return true;
    }
  });
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const transport = opts.transport ?? chatTurn;
  const maxTurns = opts.maxTurns ?? 16;
  const required = opts.requiredFiles ?? [];
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];

  let costUsd = 0;
  let finalText: string | null = null;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const { message, usage } = await transport({
      model: opts.model,
      messages,
      tools: FILE_TOOLS,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    costUsd += await resolveCostUsd(opts.model, usage);
    messages.push(message);

    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: executeTool(opts.workDir, call),
        });
      }
      continue;
    }

    // No tool calls: the model thinks it is done. Hold it to the contract.
    finalText = message.content;
    const missing = missingFiles(opts.workDir, required);
    if (missing.length === 0) {
      return { costUsd, turns: turn, finalText };
    }
    if (turn === maxTurns) break;
    messages.push({
      role: "user",
      content:
        `You are not done: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
        `still missing or empty. Use the write_file tool to write ${missing.length === 1 ? "it" : "them"} now. ` +
        `Do not reply without tool calls until every required file is written.`,
    });
  }

  const missing = missingFiles(opts.workDir, required);
  if (missing.length > 0) {
    throw new Error(
      `Agent loop ended after ${maxTurns} turns with missing file(s): ${missing.join(", ")}`,
    );
  }
  return { costUsd, turns: maxTurns, finalText };
}
