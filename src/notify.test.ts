import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmail, scoresLine } from "./notify.ts";
import type { GeneratedMeta } from "./generator.ts";
import type { JuryVerdict } from "./jury.ts";

const meta: GeneratedMeta = {
  title: "The Original",
  summary: "A certificate that hands every visitor a byte-faithful copy.",
  mechanism: "Blob download of the page's own source.",
  principles: ["P1", "P6"],
  references: ["Walter Benjamin", "Duchamp"],
  license: "CC BY-SA 4.0",
};

const verdict: JuryVerdict = {
  work_id: "2026-06-16-the-original",
  gates: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true },
  scores: { novelty: 4, nuance: 4, narrative: 4, craft: 4, wit: 4 },
  weighted_total: 40,
  max_weighted: 50,
  verdict: "strong",
  references_named: ["Walter Benjamin"],
  principles_invoked: ["P1", "P6"],
  rationale: "RATIONALE_MARKER stages the aura argument as a live mechanism.",
  reservations: null,
  revision_suggestion: null,
  jury_model: "minimax/minimax-m3",
};

test("scoresLine joins dimensions dynamically", () => {
  assert.equal(scoresLine({ concept: 3, form: 5 }), "concept 3 · form 5");
});

test("subject encodes agent name, verdict, score, and title", () => {
  const { subject } = buildEmail(
    "2026-06-16-the-original",
    meta,
    verdict,
    "http://host:4737/candidate/x",
    {},
    "hylon",
  );
  assert.equal(subject, "hylon · strong 40/50 — The Original");
});

test("body carries title, summary, rationale, scores, and dashboard url", () => {
  const url = "http://some-host:4737/candidate/2026-06-16-the-original";
  const { body } = buildEmail("2026-06-16-the-original", meta, verdict, url);
  assert.match(body, /The Original/);
  assert.match(body, /byte-faithful copy/);
  assert.match(body, /RATIONALE_MARKER/);
  assert.match(body, /novelty 4 · nuance 4/);
  assert.match(body, new RegExp(url.replace(/[.]/g, "\\.")));
});

test("body shows 'none' when there are no reservations", () => {
  const { body } = buildEmail("id", meta, verdict, "http://x");
  assert.match(body, /Reservations: none/);
});

test("refined variant flags the refinement in subject and body", () => {
  const { subject, body } = buildEmail("id", meta, verdict, "http://x", { refined: true }, "hylon");
  assert.match(subject, /refined/);
  assert.match(body, /refinement is ready/);
});
