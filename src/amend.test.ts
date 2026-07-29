import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGuidanceEntries,
  parseRefinements,
  buildAmendTask,
  parseAmendResponse,
  isNoAmendment,
  amendmentWarnings,
  type Signals,
} from "./amend.ts";
import type { Rubric } from "./config.ts";

const RUBRIC: Rubric = {
  gates: ["G1", "G2"],
  weights: { novelty: 3, wit: 1 },
  scoreMax: 5,
};

// ── signal parsing ───────────────────────────────────────────────────────────

const GUIDANCE = `# Artist guidance — accumulated from rejection notes

> header blurb

## 2026-07-01 — rejected "A"
too reverent

## 2026-07-20 — rejected "B"
more bite please`;

test("parseGuidanceEntries extracts dated entries, skipping the file header", () => {
  const entries = parseGuidanceEntries(GUIDANCE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.date, "2026-07-01");
  assert.match(entries[1]!.text, /more bite please/);
});

test("parseGuidanceEntries returns [] for empty or headerless text", () => {
  assert.deepEqual(parseGuidanceEntries(""), []);
  assert.deepEqual(parseGuidanceEntries("just prose"), []);
});

const REFINEMENTS = `
## Refinement 2026-07-10T12:00:00.000Z

**Feedback:** fix the TypeError

**Re-juried:** strong 40/50

## Refinement 2026-07-21T09:30:00.000Z

**Feedback:** raise the contrast, and slow it down

**Re-juried:** borderline 33/50
`;

test("parseRefinements extracts timestamped feedback entries", () => {
  const refs = parseRefinements(REFINEMENTS, "2026-07-09-x");
  assert.equal(refs.length, 2);
  assert.equal(refs[0]!.at, "2026-07-10T12:00:00.000Z");
  assert.equal(refs[0]!.feedback, "fix the TypeError");
  assert.match(refs[1]!.feedback, /raise the contrast/);
  assert.equal(refs[1]!.id, "2026-07-09-x");
});

// ── prompt + response ────────────────────────────────────────────────────────

const SIGNALS: Signals = {
  guidance: parseGuidanceEntries(GUIDANCE),
  refinements: parseRefinements(REFINEMENTS, "2026-07-09-x"),
  published: 2,
  rejected: 5,
  since: "2026-06-01T00:00:00.000Z",
};

test("buildAmendTask embeds signals, stats, and the rubric anchors", () => {
  const task = buildAmendTask(SIGNALS, RUBRIC);
  assert.match(task, /more bite please/);
  assert.match(task, /raise the contrast/);
  assert.match(task, /2 published, 5 rejected/);
  assert.match(task, /gates G1, G2/);
  assert.match(task, /dimensions novelty, wit/);
  assert.match(task, /===RATIONALE===/);
  assert.match(task, /===DNA===/);
});

test("parseAmendResponse splits rationale and dna", () => {
  const r = parseAmendResponse("===RATIONALE===\nbecause X\n===DNA===\n# DNA v2\nbody");
  assert.equal(r.rationale, "because X");
  assert.match(r.dna, /^# DNA v2/);
});

test("parseAmendResponse throws on missing sections", () => {
  assert.throws(() => parseAmendResponse("===RATIONALE===\nonly this"), /DNA/);
  assert.throws(() => parseAmendResponse("prose"), /RATIONALE/);
});

test("isNoAmendment detects the sentinel line", () => {
  assert.ok(isNoAmendment("NO AMENDMENT — signals are contradictory."));
  assert.ok(isNoAmendment("  NO AMENDMENT\nbecause…"));
  assert.equal(isNoAmendment("The amendment strengthens P3."), false);
});

// ── warnings ─────────────────────────────────────────────────────────────────

const CURRENT = "# DNA\ngates G1 G2\nscored: novelty wit\n" + "filler\n".repeat(20);

test("amendmentWarnings passes a faithful revision", () => {
  const proposed = CURRENT.replace("filler", "changed filler");
  assert.deepEqual(amendmentWarnings(CURRENT, proposed, RUBRIC), []);
});

test("amendmentWarnings flags vanished rubric anchors", () => {
  const proposed = CURRENT.replace("G2", "GX").replace("wit", "charm");
  const w = amendmentWarnings(CURRENT, proposed, RUBRIC);
  assert.ok(w.some((s) => /gate G2/.test(s)), w.join(" | "));
  assert.ok(w.some((s) => /"wit"/.test(s)), w.join(" | "));
});

test("amendmentWarnings flags a suspiciously shrunken document", () => {
  const w = amendmentWarnings(CURRENT, "# DNA\ngates G1 G2\nnovelty wit", RUBRIC);
  assert.ok(w.some((s) => /truncation/.test(s)), w.join(" | "));
});
