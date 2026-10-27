import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeDna, extractPrinciples, type DnaAnalysis } from "./dnainfo.ts";
import { ROOT_DIR, type Rubric } from "./config.ts";

const rubric: Rubric = {
  gates: ["G1", "G2", "G3"],
  weights: { novelty: 3, craft: 1, wit: 1 },
  scoreMax: 5,
};
const thresholds = { strong: 20, borderline: 14 };

const DNA = `---
title: "Artistic DNA — Test Artist"
version: "0.4"
date: "2026-10-01"
---

# Artistic DNA — Test Artist

## 1. One-line essence

Makes pages that *wait*.

## 3. Core principles

- **P1 — Attention as material.** Works on attention itself.
- **P2 — Restraint.** One gesture.
- P3 alone in a sentence is not a definition.

## 8. Rubric

- **G1 Attention:** does it act on attention?
- **G2 One gesture:** exactly one idea?
- **G7 Extra:** a gate the config never asks for.

Mentions G3 only in passing.

- **novelty (weight ×3):** new.
- **craft (weight ×2):** works.
- **colour (weight ×1):** a dimension the config doesn't score.

≥20 strong, 14–19 borderline, out of a 25 max.
`;

function find(a: DnaAnalysis, label: RegExp): string | undefined {
  return a.checks.find((c) => label.test(c.label))?.level;
}

test("analyzeDna reads frontmatter, essence, stats", () => {
  const a = analyzeDna(DNA, rubric, thresholds);
  assert.equal(a.title, "Artistic DNA — Test Artist");
  assert.equal(a.version, "0.4");
  assert.equal(a.date, "2026-10-01");
  assert.equal(a.essence, "Makes pages that *wait*.");
  assert.equal(a.isTemplate, false);
  assert.ok(a.stats.words > 50 && a.stats.tokens > 0);
});

test("analyzeDna: principles are list or heading definitions, not prose mentions", () => {
  const a = analyzeDna(DNA, rubric, thresholds);
  assert.deepEqual(
    a.principles.map((p) => [p.id, p.name, p.text]),
    [
      ["P1", "Attention as material", "Works on attention itself."],
      ["P2", "Restraint", "One gesture."],
    ],
  );
});

test("analyzeDna flags every kind of gate coupling", () => {
  const a = analyzeDna(DNA, rubric, thresholds);
  const byId = Object.fromEntries(a.gates.map((g) => [g.id, g]));
  assert.equal(byId.G1!.status, "defined");
  assert.equal(byId.G1!.name, "Attention");
  assert.equal(byId.G3!.status, "mentioned");
  assert.equal(byId.G7!.status, "extra");
  assert.equal(byId.G7!.inConfig, false);
  assert.equal(find(a, /gate G3 is mentioned but never defined/), "warn");
  assert.equal(find(a, /gate G7 is defined in the DNA but not in rubric\.gates/), "warn");
});

test("analyzeDna flags dimension weights that drifted, and missing/extra dimensions", () => {
  const a = analyzeDna(DNA, rubric, thresholds);
  const byId = Object.fromEntries(a.dimensions.map((d) => [d.id, d]));
  assert.equal(byId.novelty!.status, "ok");
  assert.equal(byId.craft!.status, "mismatch");
  assert.equal(byId.craft!.dnaWeight, 2);
  assert.equal(byId.wit!.status, "missing");
  assert.equal(byId.colour!.status, "extra");
  assert.equal(find(a, /craft.*DNA says ×2, config weights it ×1/), "warn");
  assert.equal(find(a, /"wit" is scored but never mentioned/), "fail");
});

test("analyzeDna compares stated thresholds with the config", () => {
  const a = analyzeDna(DNA, rubric, thresholds);
  const t = Object.fromEntries(a.thresholds.map((x) => [x.key, x]));
  assert.equal(t.strong!.dna, 20);
  assert.equal(t.borderline!.dna, 14);
  assert.equal(t.max!.dna, 25);
  assert.equal(t.max!.config, 25);
  assert.equal(a.checks.some((c) => /threshold|maximum/.test(c.label)), false);

  const off = analyzeDna(DNA, rubric, { strong: 21, borderline: 14 });
  assert.equal(find(off, /"strong" threshold: DNA states 20, config computes 21/), "warn");
});

test("analyzeDna: a missing gate is a failure", () => {
  const a = analyzeDna("# DNA\n\n- **G1 A:** x\n", rubric, thresholds);
  assert.equal(find(a, /gate G2 is in rubric\.gates but absent/), "fail");
  assert.equal(find(a, /no principle ids/), "warn");
});

test("the shipped template is coupled to the shipped rubric (and is recognized as a template)", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT_DIR, "agent.config.json"), "utf8"));
  const template = readFileSync(join(ROOT_DIR, "identity", "DNA.template.md"), "utf8");
  const a = analyzeDna(template, cfg.rubric, cfg.thresholds);
  assert.equal(a.isTemplate, true);
  assert.deepEqual(
    a.checks.filter((c) => c.level !== "ok").map((c) => c.label),
    [],
  );
  assert.equal(a.gates.filter((g) => g.status === "defined").length, cfg.rubric.gates.length);
});

test("extractPrinciples accepts heading and bold-id-only forms", () => {
  const ps = extractPrinciples("### P4 — Hospitality\n\n- **P5** — Slowness: time is material.\n");
  assert.deepEqual(
    ps.map((p) => [p.id, p.name, p.text]),
    [
      ["P4", "Hospitality", ""],
      ["P5", "Slowness", "time is material."],
    ],
  );
});

test("gates may be defined as headings, table rows, or **Gate G1 — …**", () => {
  const body = "#### G1 — Attention\n\n| Gate | Question |\n|---|---|\n| G2 | One gesture? |\n\n- **Gate G3 — Mechanism:** survives?\n";
  const a = analyzeDna(body, rubric, thresholds);
  assert.deepEqual(
    a.gates.map((g) => [g.id, g.status, g.name]),
    [
      ["G1", "defined", "Attention"],
      ["G2", "defined", "One gesture?"],
      ["G3", "defined", "Mechanism"],
    ],
  );
});

test("prose that mentions max/strong is not a threshold statement", () => {
  const a = analyzeDna(
    "- **G1 A:** a\n- **G2 B:** b\n- **G3 C:** c\n\nScored criteria (each scored 0 to 5, max 5). Strong: 3 of the 5 dimensions. A maximum of 3 colours.\n",
    rubric,
    thresholds,
  );
  assert.deepEqual(a.thresholds.map((t) => t.dna), [null, null, null]);
  assert.equal(a.checks.some((c) => /threshold|maximum score/.test(c.label)), false);
  const stated = analyzeDna("Max weighted total: 25. strong >= 20.", rubric, thresholds);
  assert.deepEqual(stated.thresholds.map((t) => t.dna), [20, null, 25]);
});
