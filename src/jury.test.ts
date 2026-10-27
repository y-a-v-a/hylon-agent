import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWeightedTotal,
  allGatesPass,
  deriveVerdict,
  assembleVerdict,
  aggregatePanel,
  extractJson,
  parseJuryModelResponse,
  buildJuryTask,
  type JuryModelResponse,
  type JurorOpinion,
} from "./jury.ts";
import { maxWeighted, normalizeJuryModels, type Rubric } from "./config.ts";

// The default rubric shape shipped in agent.config.json.
const RUBRIC: Rubric = {
  gates: ["G1", "G2", "G3", "G4", "G5", "G6"],
  weights: { novelty: 3, nuance: 3, narrative: 2, craft: 1, wit: 1 },
  scoreMax: 5,
};
const TH = { strong: 38, borderline: 30 };
const PASS_GATES = { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true };

function model(over: Partial<JuryModelResponse> = {}): JuryModelResponse {
  return {
    gates: { ...PASS_GATES },
    scores: { novelty: 5, nuance: 5, narrative: 5, craft: 5, wit: 5 },
    references_named: ["Duchamp"],
    principles_invoked: ["P1"],
    rationale: "ok",
    reservations: null,
    revision_suggestion: null,
    ...over,
  };
}

test("maxWeighted: default rubric maxes at 50", () => {
  assert.equal(maxWeighted(RUBRIC), 50);
});

test("computeWeightedTotal: perfect scores hit the rubric max", () => {
  assert.equal(computeWeightedTotal(model().scores, RUBRIC.weights), maxWeighted(RUBRIC));
});

test("computeWeightedTotal: applies the configured weights", () => {
  const total = computeWeightedTotal(
    { novelty: 4, nuance: 3, narrative: 2, craft: 1, wit: 0 },
    RUBRIC.weights,
  );
  assert.equal(total, 4 * 3 + 3 * 3 + 2 * 2 + 1 * 1 + 0); // 12+9+4+1 = 26
});

test("computeWeightedTotal works for a custom rubric shape", () => {
  const total = computeWeightedTotal({ concept: 4, form: 2 }, { concept: 5, form: 2 });
  assert.equal(total, 24);
});

test("allGatesPass requires every configured gate", () => {
  assert.equal(allGatesPass(PASS_GATES, RUBRIC.gates), true);
  assert.equal(allGatesPass({ ...PASS_GATES, G4: false }, RUBRIC.gates), false);
  // A gate the model simply omitted is a failure, not a pass.
  assert.equal(allGatesPass({ G1: true }, RUBRIC.gates), false);
});

test("deriveVerdict: any gate failure rejects regardless of score", () => {
  assert.equal(deriveVerdict({ ...PASS_GATES, G1: false }, RUBRIC.gates, 50, TH), "reject");
});

test("deriveVerdict: thresholds strong/borderline/reject", () => {
  assert.equal(deriveVerdict(PASS_GATES, RUBRIC.gates, 38, TH), "strong");
  assert.equal(deriveVerdict(PASS_GATES, RUBRIC.gates, 37, TH), "borderline");
  assert.equal(deriveVerdict(PASS_GATES, RUBRIC.gates, 30, TH), "borderline");
  assert.equal(deriveVerdict(PASS_GATES, RUBRIC.gates, 29, TH), "reject");
});

test("assembleVerdict computes total + max + verdict and preserves notes", () => {
  const v = assembleVerdict("2026-06-16-x", model(), "openai/gpt-4o", RUBRIC, TH);
  assert.equal(v.weighted_total, 50);
  assert.equal(v.max_weighted, 50);
  assert.equal(v.verdict, "strong");
  assert.equal(v.work_id, "2026-06-16-x");
  assert.equal(v.jury_model, "openai/gpt-4o");
  assert.deepEqual(v.references_named, ["Duchamp"]);
});

test("assembleVerdict: gate fail overrides a high score", () => {
  const v = assembleVerdict("id", model({ gates: { ...PASS_GATES, G6: false } }), "m", RUBRIC, TH);
  assert.equal(v.weighted_total, 50);
  assert.equal(v.verdict, "reject");
});

test("extractJson handles bare JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("extractJson handles fenced JSON with prose", () => {
  const text = "Here is my verdict:\n```json\n{\"a\": 2}\n```\nDone.";
  assert.deepEqual(extractJson(text), { a: 2 });
});

test("extractJson handles surrounding prose without fences", () => {
  assert.deepEqual(extractJson('verdict: {"a":3} thanks'), { a: 3 });
});

test("extractJson throws when no object present", () => {
  assert.throws(() => extractJson("no json here"));
});

test("parseJuryModelResponse validates a full model reply against the rubric", () => {
  const raw = JSON.stringify(model());
  const parsed = parseJuryModelResponse(raw, RUBRIC);
  assert.equal(parsed.scores.novelty, 5);
});

test("parseJuryModelResponse rejects out-of-range scores", () => {
  const bad = JSON.stringify(model({ scores: { novelty: 9, nuance: 0, narrative: 0, craft: 0, wit: 0 } }));
  assert.throws(() => parseJuryModelResponse(bad, RUBRIC));
});

test("parseJuryModelResponse rejects a reply missing a configured gate", () => {
  const bad = JSON.stringify(model({ gates: { G1: true } }));
  assert.throws(() => parseJuryModelResponse(bad, RUBRIC));
});

test("buildJuryTask embeds candidate html, motivation, meta, and rubric keys", () => {
  const files = {
    html: "<h1>UNIQUE_MARKER_HTML</h1>",
    motivation: "UNIQUE_MARKER_MOTIVATION",
    meta: {
      title: "T",
      summary: "s",
      mechanism: "m",
      principles: ["P1"],
      references: ["R"],
      license: "CC BY-SA 4.0",
    },
  };
  const task = buildJuryTask(files, "- A Catalogued Work", RUBRIC);
  assert.match(task, /UNIQUE_MARKER_HTML/);
  assert.match(task, /UNIQUE_MARKER_MOTIVATION/);
  assert.match(task, /A Catalogued Work/);
  assert.match(task, /"G1": bool/);
  assert.match(task, /"novelty": 0-5/);
});

// ── panel aggregation ────────────────────────────────────────────────────────

test("normalizeJuryModels: string → [string], array passes through", () => {
  assert.deepEqual(normalizeJuryModels("minimax/minimax-m3"), ["minimax/minimax-m3"]);
  assert.deepEqual(normalizeJuryModels(["a", "b", "c"]), ["a", "b", "c"]);
});

function opinion(
  model: string,
  scores: Record<string, number>,
  gates: Record<string, boolean> = { ...PASS_GATES },
  over: Partial<JurorOpinion> = {},
): JurorOpinion {
  const weighted_total = computeWeightedTotal(scores, RUBRIC.weights);
  return {
    work_id: "2026-06-16-x",
    gates,
    scores,
    weighted_total,
    max_weighted: maxWeighted(RUBRIC),
    verdict: deriveVerdict(gates, RUBRIC.gates, weighted_total, TH),
    references_named: [`ref-${model}`],
    principles_invoked: ["P1"],
    rationale: `rationale from ${model}`,
    reservations: null,
    revision_suggestion: null,
    jury_model: model,
    ...over,
  };
}

const S_HIGH = { novelty: 5, nuance: 5, narrative: 5, craft: 5, wit: 5 };
const S_MID = { novelty: 4, nuance: 4, narrative: 4, craft: 4, wit: 4 };
const S_LOW = { novelty: 2, nuance: 2, narrative: 2, craft: 2, wit: 2 };

test("aggregatePanel: a single opinion passes through unchanged (no panel field)", () => {
  const o = opinion("solo/model", S_MID);
  const v = aggregatePanel([o], RUBRIC, TH);
  assert.deepEqual(v, o);
  assert.equal(v.panel, undefined);
});

test("aggregatePanel: unanimous panel aggregates medians and records all opinions", () => {
  const v = aggregatePanel(
    [opinion("a", S_MID), opinion("b", S_MID), opinion("c", S_MID)],
    RUBRIC,
    TH,
  );
  assert.equal(v.verdict, "strong"); // 40 ≥ 38
  assert.equal(v.weighted_total, 40);
  assert.equal(v.unanimous, true);
  assert.equal(v.panel?.length, 3);
  assert.equal(v.jury_model, "a + b + c");
  assert.match(v.rationale, /Panel of 3 — 3 strong, unanimous/);
});

test("aggregatePanel: median scores decide — one outlier cannot swing the panel", () => {
  const v = aggregatePanel(
    [opinion("a", S_HIGH), opinion("b", S_MID), opinion("c", S_LOW)],
    RUBRIC,
    TH,
  );
  assert.equal(v.scores.novelty, 4); // median of 5,4,2
  assert.equal(v.weighted_total, 40);
  assert.equal(v.verdict, "strong");
  assert.equal(v.unanimous, false);
  assert.match(v.rationale, /2 strong · 1 reject/);
});

test("aggregatePanel: even panel takes the middle average (fractional totals allowed)", () => {
  const v = aggregatePanel([opinion("a", S_HIGH), opinion("b", S_MID)], RUBRIC, TH);
  assert.equal(v.scores.novelty, 4.5);
  assert.equal(v.weighted_total, 45);
});

test("aggregatePanel: gate needs a STRICT majority — a tie fails conservatively", () => {
  const fail = { ...PASS_GATES, G5: false };
  // 1/2 jurors pass G5 → tie → gate fails → reject despite high scores
  const v = aggregatePanel(
    [opinion("a", S_HIGH), opinion("b", S_HIGH, fail)],
    RUBRIC,
    TH,
  );
  assert.equal(v.gates.G5, false);
  assert.equal(v.verdict, "reject");
  // 2/3 pass → gate passes
  const v3 = aggregatePanel(
    [opinion("a", S_HIGH), opinion("b", S_HIGH, fail), opinion("c", S_HIGH)],
    RUBRIC,
    TH,
  );
  assert.equal(v3.gates.G5, true);
  assert.equal(v3.verdict, "strong");
});

test("aggregatePanel: unions references/principles and attributes reservations", () => {
  const v = aggregatePanel(
    [
      opinion("a", S_MID, { ...PASS_GATES }, { reservations: "too tidy" }),
      opinion("b", S_MID),
      opinion("c", S_MID, { ...PASS_GATES }, { revision_suggestion: "loosen the grid" }),
    ],
    RUBRIC,
    TH,
  );
  assert.deepEqual(v.references_named.sort(), ["ref-a", "ref-b", "ref-c"]);
  assert.match(v.reservations ?? "", /^a: too tidy/);
  assert.equal(v.revision_suggestion, "loosen the grid");
});

test("buildJuryTask sanctions declared vendored-library placeholders", () => {
  const files = {
    html: `<script data-vendor="threejs"></script>`,
    motivation: "m",
    meta: { title: "T", summary: "s", mechanism: "m", principles: ["P1"], references: ["R"], license: "L" },
  };
  const task = buildJuryTask(files, "-", RUBRIC, ["threejs"]);
  assert.match(task, /allowed names: threejs/);
  assert.match(task, /Do not treat such a tag as an external dependency/);
  // and without vendored libraries the note is absent
  assert.doesNotMatch(buildJuryTask(files, "-", RUBRIC), /vendored/i);
});

test("buildJuryTask reflects a custom rubric in the response template", () => {
  const files = {
    html: "<p>x</p>",
    motivation: "m",
    meta: { title: "T", summary: "s", mechanism: "m", principles: ["A"], references: ["R"], license: "L" },
  };
  const rubric: Rubric = { gates: ["HG1", "HG2"], weights: { concept: 4, form: 2 }, scoreMax: 10 };
  const task = buildJuryTask(files, "-", rubric);
  assert.match(task, /"HG1": bool, "HG2": bool/);
  assert.match(task, /"concept": 0-10, "form": 0-10/);
});
