import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublishable, uniqueId } from "./loop.ts";

test("isPublishable: clean + strong publishes", () => {
  assert.equal(isPublishable("strong", []), true);
});

test("isPublishable: clean + borderline publishes", () => {
  assert.equal(isPublishable("borderline", []), true);
});

test("isPublishable: reject never publishes", () => {
  assert.equal(isPublishable("reject", []), false);
});

test("isPublishable: self-containment violation blocks even a strong verdict", () => {
  assert.equal(isPublishable("strong", ["external src: https://x"]), false);
});

test("uniqueId returns base id when free", () => {
  assert.equal(uniqueId("2026-06-16-x", () => false), "2026-06-16-x");
});

test("uniqueId suffixes on collision", () => {
  const taken = new Set(["2026-06-16-x", "2026-06-16-x-2"]);
  assert.equal(uniqueId("2026-06-16-x", (id) => taken.has(id)), "2026-06-16-x-3");
});
