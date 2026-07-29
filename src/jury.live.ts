import { test } from "node:test";
import assert from "node:assert/strict";
import { juryCandidate, computeWeightedTotal } from "./jury.ts";
import { loadConfig, maxWeighted } from "./config.ts";
import type { GeneratedFiles } from "./generator.ts";

// TIER 1 — opt-in live contract test. Makes ONE real OpenRouter call (~$0.005)
// to confirm the configured jury model still exists, still returns parseable
// JSON, and that our extractJson + zod schema + verdict assembly all hold
// against the real API. Run with `npm run test:live`. NOT part of `npm test`
// (the filename is *.live.ts, not *.test.ts) so it never runs in CI or on a
// normal change. Skips cleanly when OPENROUTER_API_KEY is absent.

const fixture: GeneratedFiles = {
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>This Page Intentionally Left</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#fff;color:#111;font:300 6vw/1 Georgia,serif}</style></head>
<body><p>This page intentionally left.</p>
<footer style="position:fixed;bottom:1rem;left:1rem;font:11px monospace;color:#999">CC BY-SA 4.0</footer></body></html>`,
  motivation: `The boilerplate disclaimer "this page intentionally left blank" is truncated mid-sentence so the page itself becomes the absence it announces — the mechanism is the joke. Smallest possible build; dry, double-coded. Answers the printing-convention readymade, recontextualized as a served web page.`,
  meta: {
    title: "This Page Intentionally Left",
    summary: 'The "intentionally left blank" disclaimer, truncated so the page is the absence.',
    mechanism: "A served page whose only content is the self-referential, truncated disclaimer.",
    principles: ["P1"],
    references: ['the "this page intentionally left blank" printing convention'],
    license: "CC BY-SA 4.0",
  },
};

test(
  "live jury contract: a real OpenRouter call returns a usable verdict",
  { skip: process.env.OPENROUTER_API_KEY ? false : "OPENROUTER_API_KEY not set" },
  async () => {
    const cfg = loadConfig();
    const { verdict, usage } = await juryCandidate("2026-06-16-live-contract", fixture);

    // gates are booleans for every configured gate
    for (const g of cfg.rubric.gates) {
      assert.equal(typeof verdict.gates[g], "boolean", `gate ${g}`);
    }
    // scores are integers in 0..scoreMax for every configured dimension
    for (const k of Object.keys(cfg.rubric.weights)) {
      const s = verdict.scores[k];
      assert.ok(
        Number.isInteger(s) && s! >= 0 && s! <= cfg.rubric.scoreMax,
        `score ${k}=${s}`,
      );
    }
    // the harness — not the model — computed the total and verdict, consistently
    assert.equal(verdict.weighted_total, computeWeightedTotal(verdict.scores, cfg.rubric.weights));
    assert.equal(verdict.max_weighted, maxWeighted(cfg.rubric));
    assert.ok(verdict.weighted_total >= 0 && verdict.weighted_total <= verdict.max_weighted);
    assert.ok(["strong", "borderline", "reject"].includes(verdict.verdict));
    assert.equal(verdict.work_id, "2026-06-16-live-contract");
    assert.ok(verdict.rationale.length > 0, "rationale present");
    assert.ok(usage.prompt_tokens > 0 && usage.completion_tokens > 0, "usage reported");

    console.error(
      `[test:live] ${verdict.jury_model}: ${verdict.verdict} ${verdict.weighted_total}/${verdict.max_weighted} ` +
        `(${usage.prompt_tokens}+${usage.completion_tokens} tok)`,
    );
  },
);
