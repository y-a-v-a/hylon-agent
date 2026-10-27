import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chat, chatTurn, setLedgerPath } from "./openrouter.ts";
import { readUsage } from "./usage.ts";

// The usage ledger as chatTurn writes it: every outcome of a call leaves one
// line, tagged with purpose and run, and the call's control flow is unchanged.
// fetch is stubbed and the ledger redirected — no network, no repo writes.

test("chatTurn records one ledger line per call, whatever the outcome", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-ledger-"));
  const ledger = join(dir, "usage.jsonl");
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test-not-a-real-key";
  setLedgerPath(() => ledger);
  const reply = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
  const last = () => readUsage(ledger).at(-1)!;
  try {
    await t.test("success: tokens, reported cost, provider, generation id, purpose, run", async () => {
      globalThis.fetch = reply({
        id: "gen-1",
        provider: "Anthropic",
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      });
      const r = await chat({ model: "a/b", system: "s", user: "u", purpose: "jury", run: "r1" });
      assert.equal(r.content, "hello");
      assert.deepEqual(
        { ...last(), at: "", ms: 0 },
        { at: "", ms: 0, purpose: "jury", model: "a/b", run: "r1", ok: true, promptTokens: 10, completionTokens: 5, costUsd: 0.001, provider: "Anthropic", generationId: "gen-1" },
      );
    });

    await t.test("HTTP error: recorded as failed, and still thrown", async () => {
      globalThis.fetch = reply("upstream exploded", 502);
      await assert.rejects(chatTurn({ model: "a/b", messages: [], purpose: "generate" }), /OpenRouter 502: upstream exploded/);
      assert.equal(last().ok, false);
      assert.match(last().error ?? "", /502/);
      assert.equal(last().purpose, "generate");
    });

    await t.test("network error: recorded, and the original error is rethrown", async () => {
      globalThis.fetch = (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as typeof fetch;
      await assert.rejects(chatTurn({ model: "a/b", messages: [] }), /ENOTFOUND/);
      assert.equal(last().ok, false);
      assert.equal(last().purpose, "other", "untagged calls are 'other'");
    });

    await t.test("unreadable body: recorded, and thrown", async () => {
      globalThis.fetch = reply("<html>not json</html>");
      await assert.rejects(chatTurn({ model: "a/b", messages: [] }));
      assert.match(last().error ?? "", /unreadable response/);
    });

    await t.test("no message: recorded with usage, and thrown as before", async () => {
      globalThis.fetch = reply({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 0, cost: 0.0001 } });
      await assert.rejects(chatTurn({ model: "a/b", messages: [] }), /returned no message/);
      assert.equal(last().ok, false);
      assert.equal(last().costUsd, 0.0001, "the cost is kept even for a failed call");
    });

    await t.test("an empty message is a failure for the record, but chatTurn still returns it", async () => {
      globalThis.fetch = reply({ choices: [{ message: { content: null } }], usage: { prompt_tokens: 3, completion_tokens: 0 } });
      const r = await chatTurn({ model: "a/b", messages: [] });
      assert.equal(r.message.content, null);
      assert.equal(last().ok, false);
      assert.match(last().error ?? "", /empty message/);
      assert.equal(last().costUsd, null, "no reported cost stays null");
    });

    await t.test("an unwritable ledger never fails the call", async () => {
      setLedgerPath(() => join(dir, "usage.jsonl", "not-a-dir", "x.jsonl"));
      globalThis.fetch = reply({ choices: [{ message: { content: "fine" } }] });
      assert.equal((await chat({ model: "a/b", system: "s", user: "u" })).content, "fine");
    });
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = realKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
