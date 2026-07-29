import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeTool,
  resolveWorkPath,
  runAgentLoop,
  type Transport,
} from "./agentloop.ts";
import type { ChatMessage, ChatTurnResult, ToolCall } from "./openrouter.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "agent-loop-"));
}

function call(name: string, args: unknown, id = "c1"): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// ── resolveWorkPath ──────────────────────────────────────────────────────────

test("resolveWorkPath resolves inside the work dir, including nested paths", () => {
  const dir = tmp();
  try {
    assert.equal(resolveWorkPath(dir, "index.html"), join(dir, "index.html"));
    assert.equal(resolveWorkPath(dir, "a/b.txt"), join(dir, "a", "b.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorkPath rejects traversal and absolute escapes", () => {
  const dir = tmp();
  try {
    assert.throws(() => resolveWorkPath(dir, "../evil.txt"), /escapes/);
    assert.throws(() => resolveWorkPath(dir, "a/../../evil.txt"), /escapes/);
    assert.throws(() => resolveWorkPath(dir, "/etc/passwd"), /escapes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── executeTool ──────────────────────────────────────────────────────────────

test("executeTool write/read/list round-trip", () => {
  const dir = tmp();
  try {
    const wrote = executeTool(dir, call("write_file", { path: "index.html", content: "<h1>X</h1>" }));
    assert.match(wrote, /Wrote index\.html/);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<h1>X</h1>");

    assert.equal(executeTool(dir, call("read_file", { path: "index.html" })), "<h1>X</h1>");

    executeTool(dir, call("write_file", { path: "sub/meta.json", content: "{}" }));
    const listing = executeTool(dir, call("list_files", {}));
    assert.equal(listing, ["index.html", join("sub", "meta.json")].sort().join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("executeTool returns ERROR results instead of throwing", () => {
  const dir = tmp();
  try {
    assert.match(executeTool(dir, call("read_file", { path: "nope.txt" })), /^ERROR: /);
    assert.match(executeTool(dir, call("write_file", { path: "../evil", content: "x" })), /escapes/);
    assert.match(executeTool(dir, call("write_file", { path: "x" })), /^ERROR: write_file requires/);
    assert.match(executeTool(dir, call("no_such_tool", {})), /^ERROR: unknown tool/);
    // malformed arguments JSON
    const bad: ToolCall = { id: "c", type: "function", function: { name: "read_file", arguments: "{not json" } };
    assert.match(executeTool(dir, bad), /^ERROR: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runAgentLoop (scripted transport) ────────────────────────────────────────

const META = JSON.stringify({
  title: "T",
  summary: "s",
  mechanism: "m",
  principles: ["P1"],
  references: ["R"],
  license: "CC BY-SA 4.0",
});

/** A transport that replays scripted assistant messages and records requests. */
function scripted(replies: ChatMessage[]): { transport: Transport; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let i = 0;
  const transport: Transport = async (opts): Promise<ChatTurnResult> => {
    requests.push(structuredClone(opts.messages));
    const message = replies[i++];
    if (!message) throw new Error("scripted transport exhausted");
    return { message, usage: { prompt_tokens: 10, completion_tokens: 5, costUsd: 0.01 } };
  };
  return { transport, requests };
}

test("runAgentLoop executes tool calls, feeds results back, sums cost, and finishes", async () => {
  const dir = tmp();
  try {
    const { transport, requests } = scripted([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("write_file", { path: "index.html", content: "<!doctype html><h1>W</h1>" }, "a"),
          call("write_file", { path: "motivation.md", content: "why" }, "b"),
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("write_file", { path: "meta.json", content: META }, "c")],
      },
      { role: "assistant", content: "Done — a small work about W." },
    ]);

    const result = await runAgentLoop({
      model: "test/model",
      system: "SYS",
      task: "TASK",
      workDir: dir,
      requiredFiles: ["index.html", "motivation.md", "meta.json"],
      transport,
    });

    assert.equal(result.turns, 3);
    assert.equal(result.costUsd.toFixed(2), "0.03"); // 3 × 0.01, provider-reported
    assert.match(result.finalText ?? "", /Done/);
    assert.match(readFileSync(join(dir, "index.html"), "utf8"), /<h1>W<\/h1>/);

    // Turn 2's request must contain the tool results for turn 1's two calls.
    const second = requests[1]!;
    const toolMsgs = second.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    assert.equal(toolMsgs[0]!.tool_call_id, "a");
    assert.match(toolMsgs[0]!.content ?? "", /Wrote index\.html/);
    // And the system/task framing survives at the head of the history.
    assert.equal(second[0]!.role, "system");
    assert.equal(second[0]!.content, "SYS");
    assert.equal(second[1]!.content, "TASK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentLoop reminds the model when it stops with required files missing", async () => {
  const dir = tmp();
  try {
    const { transport, requests } = scripted([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("write_file", { path: "index.html", content: "<h1>W</h1>" }, "a")],
      },
      { role: "assistant", content: "I think I'm done." }, // too early
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("write_file", { path: "motivation.md", content: "why" }, "b"),
          call("write_file", { path: "meta.json", content: META }, "c"),
        ],
      },
      { role: "assistant", content: "Now done." },
    ]);

    const result = await runAgentLoop({
      model: "test/model",
      system: "SYS",
      task: "TASK",
      workDir: dir,
      requiredFiles: ["index.html", "motivation.md", "meta.json"],
      transport,
    });

    assert.equal(result.turns, 4);
    // The request after the premature stop carries the reminder as a user turn.
    const reminder = requests[2]!.at(-1)!;
    assert.equal(reminder.role, "user");
    assert.match(reminder.content ?? "", /not done/);
    assert.match(reminder.content ?? "", /motivation\.md, meta\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentLoop treats an empty required file as missing", async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "index.html"), "   \n"); // exists but blank
    const { transport } = scripted([
      { role: "assistant", content: "done" },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("write_file", { path: "index.html", content: "<h1>W</h1>" }, "a")],
      },
      { role: "assistant", content: "done for real" },
    ]);
    const result = await runAgentLoop({
      model: "test/model",
      system: "SYS",
      task: "TASK",
      workDir: dir,
      requiredFiles: ["index.html"],
      transport,
    });
    assert.equal(result.turns, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentLoop throws after maxTurns with files still missing", async () => {
  const dir = tmp();
  try {
    const { transport } = scripted([
      { role: "assistant", content: "nope" },
      { role: "assistant", content: "still nope" },
    ]);
    await assert.rejects(
      runAgentLoop({
        model: "test/model",
        system: "SYS",
        task: "TASK",
        workDir: dir,
        requiredFiles: ["index.html"],
        maxTurns: 2,
        transport,
      }),
      /missing file\(s\): index\.html/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentLoop surfaces a traversal attempt to the model as an ERROR result", async () => {
  const dir = tmp();
  try {
    const { transport, requests } = scripted([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("write_file", { path: "../outside.txt", content: "x" }, "a")],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("write_file", { path: "index.html", content: "<h1>ok</h1>" }, "b")],
      },
      { role: "assistant", content: "done" },
    ]);
    await runAgentLoop({
      model: "test/model",
      system: "SYS",
      task: "TASK",
      workDir: dir,
      requiredFiles: ["index.html"],
      transport,
    });
    const toolResult = requests[1]!.at(-1)!;
    assert.equal(toolResult.role, "tool");
    assert.match(toolResult.content ?? "", /ERROR: .*escapes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
