import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendUsage, dailyUsage, entryCost, parseUsage, readUsage, summarizeUsage, type UsageEntry } from "./usage.ts";

const entry = (over: Partial<UsageEntry>): UsageEntry => ({
  at: "2026-10-20T06:00:00.000Z",
  purpose: "generate",
  model: "anthropic/claude-sonnet-4.5",
  ok: true,
  promptTokens: 1000,
  completionTokens: 100,
  costUsd: 0.01,
  ms: 2000,
  ...over,
});

test("appendUsage creates the ledger and appends one JSON line per call", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-usage-"));
  try {
    const path = join(dir, "logs", "usage.jsonl");
    appendUsage(path, entry({}));
    appendUsage(path, entry({ purpose: "jury", model: "minimax/minimax-m3" }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(readUsage(path)[1]!.purpose, "jury");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readUsage of a missing ledger is empty", () => {
  assert.deepEqual(readUsage(join(tmpdir(), "no-such-dir-xyz", "usage.jsonl")), []);
});

test("parseUsage skips torn and foreign lines and normalizes fields", () => {
  const text = [
    JSON.stringify(entry({})),
    "not json",
    JSON.stringify({ hello: "world" }),
    JSON.stringify({ at: "2026-10-20T07:00:00Z", model: "x/y", ok: false }),
    '{"at":"2026-10-2', // torn last line (crash mid-append)
  ].join("\n");
  const out = parseUsage(text);
  assert.equal(out.length, 2);
  assert.equal(out[1]!.purpose, "other");
  assert.equal(out[1]!.costUsd, null);
  assert.equal(out[1]!.promptTokens, 0);
});

test("entryCost prefers the reported cost, else estimates from pricing (flagged)", () => {
  assert.deepEqual(entryCost(entry({ costUsd: 0.5 })), { usd: 0.5, estimated: false });
  const price = () => ({ prompt: 1e-6, completion: 2e-6 });
  const est = entryCost(entry({ costUsd: null, promptTokens: 1000, completionTokens: 500 }), price);
  assert.equal(est.estimated, true);
  assert.ok(Math.abs(est.usd - 0.002) < 1e-12);
  assert.deepEqual(entryCost(entry({ costUsd: null })), { usd: 0, estimated: true });
});

test("summarizeUsage groups by model × purpose, counts runs and errors, most expensive first", () => {
  const rows = summarizeUsage([
    entry({ run: "a", costUsd: 0.1 }),
    entry({ run: "a", costUsd: 0.2, provider: "Anthropic" }),
    entry({ run: "b", costUsd: 0.3, provider: "Anthropic", at: "2026-10-21T00:00:00.000Z" }),
    entry({ purpose: "jury", model: "minimax/minimax-m3", costUsd: 0.01 }),
    entry({ purpose: "jury", model: "minimax/minimax-m3", ok: false, costUsd: null, error: "502" }),
  ]);
  assert.equal(rows.length, 2);
  const gen = rows[0]!;
  assert.equal(gen.model, "anthropic/claude-sonnet-4.5");
  assert.equal(gen.calls, 3);
  assert.equal(gen.runs, 2);
  assert.ok(Math.abs(gen.costUsd - 0.6) < 1e-9);
  assert.equal(gen.lastAt, "2026-10-21T00:00:00.000Z");
  assert.deepEqual(gen.providers, { Anthropic: 2 });
  const jury = rows[1]!;
  assert.equal(jury.errors, 1);
  assert.equal(jury.runs, 2, "untagged calls count as their own runs");
  assert.equal(jury.estimatedCalls, 0, "failed calls aren't 'estimated' — they cost nothing");
});

test("dailyUsage zero-fills the window and buckets by UTC date", () => {
  const days = dailyUsage(
    [
      entry({ at: "2026-10-20T23:59:00.000Z", costUsd: 1 }),
      entry({ at: "2026-10-20T01:00:00.000Z", purpose: "jury", costUsd: 0.5 }),
      entry({ at: "2026-09-01T00:00:00.000Z", costUsd: 9 }), // outside the window
    ],
    3,
    new Date("2026-10-21T12:00:00Z"),
  );
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-10-19", "2026-10-20", "2026-10-21"],
  );
  assert.equal(days[0]!.total, 0);
  assert.equal(days[1]!.total, 1.5);
  assert.equal(days[1]!.calls, 2);
  assert.deepEqual(days[1]!.byPurpose, { generate: 1, jury: 0.5 });
});
