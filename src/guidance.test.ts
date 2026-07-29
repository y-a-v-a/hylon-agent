import { test } from "node:test";
import assert from "node:assert/strict";
import { recentGuidance } from "./guidance.ts";

const file = `# Artist guidance — accumulated from rejection notes

> The generator reads recent entries each round and treats them as direction.
> The jury does not read this. Edit or prune freely.

## 2026-06-15 — rejected "A"
too reverent

## 2026-06-16 — rejected "B"
needs more bite

## 2026-06-17 — rejected "C"
the gradient is muddy`;

test("recentGuidance returns '' when empty", () => {
  assert.equal(recentGuidance(""), "");
});

test("recentGuidance drops the file header/blockquote and keeps entries", () => {
  const out = recentGuidance(file);
  assert.doesNotMatch(out, /Artist guidance —/);
  assert.doesNotMatch(out, /jury does not read/);
  assert.match(out, /rejected "A"/);
  assert.match(out, /rejected "C"/);
});

test("recentGuidance caps to the last N entries", () => {
  const out = recentGuidance(file, 1);
  assert.match(out, /rejected "C"/);
  assert.doesNotMatch(out, /rejected "A"/);
  assert.doesNotMatch(out, /rejected "B"/);
});
