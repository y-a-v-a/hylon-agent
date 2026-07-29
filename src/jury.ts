import { z } from "zod";
import { loadConfig, maxWeighted, type Rubric } from "./config.ts";
import { loadDna } from "./dna.ts";
import { catalogueDigest } from "./catalogue.ts";
import type { GeneratedFiles } from "./generator.ts";
import { chat, type Usage } from "./openrouter.ts";

// The rubric (gate ids, score dimensions, weights) comes from agent.config.json;
// the DNA document defines what the gates and dimensions MEAN. The model judges;
// the harness — not the model — does all arithmetic and the pass/fail decision.

export type Gates = Record<string, boolean>;
export type Scores = Record<string, number>;

export interface JuryModelResponse {
  gates: Gates;
  scores: Scores;
  references_named: string[];
  principles_invoked: string[];
  rationale: string;
  reservations: string | null;
  revision_suggestion: string | null;
}

export type Verdict = "strong" | "borderline" | "reject";

// ── Final verdict object (weighted_total + verdict computed by the harness) ──
export interface JuryVerdict {
  work_id: string;
  gates: Gates;
  scores: Scores;
  weighted_total: number;
  /** Maximum achievable weighted total under the rubric (self-describing). */
  max_weighted: number;
  verdict: Verdict;
  references_named: string[];
  principles_invoked: string[];
  rationale: string;
  reservations: string | null;
  revision_suggestion: string | null;
  jury_model: string;
}

// ── Deterministic gate/score logic (pure, testable) ──────────────────────────
export function computeWeightedTotal(scores: Scores, weights: Record<string, number>): number {
  return Object.entries(weights).reduce((sum, [k, w]) => sum + (scores[k] ?? 0) * w, 0);
}

export function allGatesPass(gates: Gates, gateIds: readonly string[]): boolean {
  return gateIds.every((g) => gates[g] === true);
}

/**
 * Any hard-gate failure ⇒ reject regardless of score. Otherwise threshold on
 * the weighted total. Thresholds come from config.
 */
export function deriveVerdict(
  gates: Gates,
  gateIds: readonly string[],
  weightedTotal: number,
  thresholds: { strong: number; borderline: number },
): Verdict {
  if (!allGatesPass(gates, gateIds)) return "reject";
  if (weightedTotal >= thresholds.strong) return "strong";
  if (weightedTotal >= thresholds.borderline) return "borderline";
  return "reject";
}

export function assembleVerdict(
  workId: string,
  model: JuryModelResponse,
  juryModel: string,
  rubric: Rubric,
  thresholds: { strong: number; borderline: number },
): JuryVerdict {
  const weighted_total = computeWeightedTotal(model.scores, rubric.weights);
  return {
    work_id: workId,
    gates: model.gates,
    scores: model.scores,
    weighted_total,
    max_weighted: maxWeighted(rubric),
    verdict: deriveVerdict(model.gates, rubric.gates, weighted_total, thresholds),
    references_named: model.references_named,
    principles_invoked: model.principles_invoked,
    rationale: model.rationale,
    reservations: model.reservations,
    revision_suggestion: model.revision_suggestion,
    jury_model: juryModel,
  };
}

// ── Schema for what we ask the model to return (built from the rubric) ───────
export function juryModelSchema(rubric: Rubric): z.ZodType<JuryModelResponse> {
  const gateShape = Object.fromEntries(rubric.gates.map((g) => [g, z.boolean()]));
  const scoreShape = Object.fromEntries(
    Object.keys(rubric.weights).map((k) => [k, z.number().int().min(0).max(rubric.scoreMax)]),
  );
  return z.object({
    gates: z.object(gateShape),
    scores: z.object(scoreShape),
    references_named: z.array(z.string()),
    principles_invoked: z.array(z.string()),
    rationale: z.string(),
    reservations: z.string().nullable(),
    revision_suggestion: z.string().nullable(),
  }) as unknown as z.ZodType<JuryModelResponse>;
}

// ── Prompt construction (pure, testable) ─────────────────────────────────────
export function buildJurySystemPrompt(dna: string): string {
  return [
    "You are the JURY agent for an autonomous art practice.",
    "Apply the validation rubric defined in the artistic DNA below strictly.",
    "Judge the candidate on its own merits against this DNA — do not be generous.",
    "You did not make this work.",
    "",
    "--- ARTISTIC DNA ---",
    dna,
  ].join("\n");
}

export function buildJuryTask(
  files: GeneratedFiles,
  digest: string,
  rubric: Rubric,
  vendoredLibraries: string[] = [],
): string {
  const gatesTemplate = rubric.gates.map((g) => `"${g}": bool`).join(", ");
  const scoresTemplate = Object.keys(rubric.weights)
    .map((k) => `"${k}": 0-${rubric.scoreMax}`)
    .join(", ");
  const vendorNote = vendoredLibraries.length
    ? `\nNote on vendored libraries: a tag like <script data-vendor="name"></script> (allowed names: ${vendoredLibraries.join(", ")}) is sanctioned — the harness inlines the full library source at render time, and the published work still makes zero external requests. Do not treat such a tag as an external dependency or an ethics violation; do judge whether using the library is justified by the idea.\n`
    : "";
  return `Judge the candidate work below against the DNA's validation rubric.${vendorNote}

Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
{
  "gates": {${gatesTemplate}},
  "scores": {${scoresTemplate}},
  "references_named": string[],
  "principles_invoked": string[],
  "rationale": "2-4 sentences",
  "reservations": string | null,
  "revision_suggestion": string | null
}

Apply the hard gates first; a single gate failure means the work fails regardless of score. Score honestly against the DNA's scored criteria. Do NOT compute a total or verdict — only provide gates, scores, and notes.

The work must be materially distinct (not a duplicate) from every catalogued work:
${digest}

=== CANDIDATE meta.json ===
${JSON.stringify(files.meta, null, 2)}

=== CANDIDATE motivation.md ===
${files.motivation}

=== CANDIDATE index.html ===
${files.html}`;
}

// ── JSON extraction (pure, testable) ─────────────────────────────────────────
/** Strip markdown fences / surrounding prose and parse the first JSON object. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in jury response");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseJuryModelResponse(text: string, rubric: Rubric): JuryModelResponse {
  return juryModelSchema(rubric).parse(extractJson(text));
}

// ── OpenRouter call (integration) ────────────────────────────────────────────
export type { Usage };

/** Grade a candidate. Returns the verdict plus token usage for the fuse. */
export async function juryCandidate(
  workId: string,
  files: GeneratedFiles,
): Promise<{ verdict: JuryVerdict; usage: Usage }> {
  const cfg = loadConfig();
  const { content, usage } = await chat({
    model: cfg.models.jury,
    system: buildJurySystemPrompt(loadDna()),
    user: buildJuryTask(
      files,
      catalogueDigest(),
      cfg.rubric,
      Object.keys(cfg.technologies.libraries),
    ),
    json: true,
    temperature: 0.2,
  });
  const model = parseJuryModelResponse(content, cfg.rubric);
  const verdict = assembleVerdict(workId, model, cfg.models.jury, cfg.rubric, cfg.thresholds);
  return { verdict, usage };
}
