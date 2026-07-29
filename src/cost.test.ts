import { test } from "node:test";
import assert from "node:assert/strict";
import { usageCostUsd, fuseCheck, resolveDaySpend } from "./cost.ts";

const PRICING = { prompt: 0.3e-6, completion: 1.2e-6 };

test("usageCostUsd multiplies tokens by per-token price", () => {
  const cost = usageCostUsd(PRICING, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.equal(cost.toFixed(2), "1.50"); // 0.30 + 1.20
});

test("usageCostUsd prefers the provider-reported cost when present", () => {
  const cost = usageCostUsd(PRICING, {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    costUsd: 0.42,
  });
  assert.equal(cost, 0.42);
});

test("fuseCheck returns null when under both caps", () => {
  assert.equal(fuseCheck(1, 5, { perWakeUsd: 5, perDayUsd: 20 }), null);
});

test("fuseCheck trips on per-wake cap", () => {
  const r = fuseCheck(5, 5, { perWakeUsd: 5, perDayUsd: 20 });
  assert.match(String(r), /per-wake cap/);
});

test("fuseCheck trips on daily cap first", () => {
  const r = fuseCheck(1, 20, { perWakeUsd: 5, perDayUsd: 20 });
  assert.match(String(r), /daily cap/);
});

test("resolveDaySpend: null state means zero", () => {
  assert.equal(resolveDaySpend(null, "2026-06-16"), 0);
});

test("resolveDaySpend: same day accumulates", () => {
  assert.equal(resolveDaySpend(JSON.stringify({ date: "2026-06-16", spentUsd: 3.5 }), "2026-06-16"), 3.5);
});

test("resolveDaySpend: new day resets", () => {
  assert.equal(resolveDaySpend(JSON.stringify({ date: "2026-06-15", spentUsd: 9 }), "2026-06-16"), 0);
});

test("resolveDaySpend: malformed state resets safely", () => {
  assert.equal(resolveDaySpend("{not json", "2026-06-16"), 0);
});
