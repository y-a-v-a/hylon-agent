import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffStats, collapseOps, renderDiffText } from "./diff.ts";

const A = ["one", "two", "three", "four", "five"].join("\n");
const B = ["one", "two changed", "three", "four", "five", "six"].join("\n");

test("diffLines: identical texts produce only 'same' ops", () => {
  const ops = diffLines(A, A);
  assert.ok(ops.every((o) => o.type === "same"));
  assert.equal(ops.length, 5);
});

test("diffLines: a changed line is a del + add; an appended line is an add", () => {
  const ops = diffLines(A, B);
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  assert.ok(ops.some((o) => o.type === "del" && o.line === "two"));
  assert.ok(ops.some((o) => o.type === "add" && o.line === "two changed"));
  assert.ok(ops.some((o) => o.type === "add" && o.line === "six"));
});

test("diffLines handles empty inputs", () => {
  assert.deepEqual(diffStats(diffLines("", "a\nb")), { added: 2, removed: 1 }); // "" is one empty line
  assert.equal(diffLines("", "").length, 1);
});

test("collapseOps keeps context around changes and gaps elsewhere", () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const bLines = a.split("\n");
  bLines[15] = "line 15 CHANGED";
  const collapsed = collapseOps(diffLines(a, bLines.join("\n")), 2);
  const gaps = collapsed.filter((o) => o.type === "gap");
  assert.equal(gaps.length, 2); // before and after the change window
  const kept = collapsed.filter((o) => o.type !== "gap");
  assert.equal(kept.length, 2 + 2 + 2); // 2 context + del + add + 2 context
});

test("renderDiffText prefixes lines and marks gaps", () => {
  const text = renderDiffText(diffLines(A, B), 1);
  assert.match(text, /^- two$/m);
  assert.match(text, /^\+ two changed$/m);
  assert.match(text, /unchanged line/);
});
