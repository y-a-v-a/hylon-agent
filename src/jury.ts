import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig, maxWeighted, normalizeJuryModels, type Rubric } from "./config.ts";
import { loadDna } from "./dna.ts";
import { catalogueDigest } from "./catalogue.ts";
import type { GeneratedFiles } from "./generator.ts";
import { chat, type Usage } from "./openrouter.ts";
import { resolveCostUsd } from "./cost.ts";

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
  /** Panel juries only: every juror's full independent opinion (the dissents). */
  panel?: JurorOpinion[];
  /** Panel juries only: whether all jurors reached the same verdict. */
  unanimous?: boolean;
}

/** One juror's complete independent verdict (a JuryVerdict without panel data). */
export type JurorOpinion = Omit<JuryVerdict, "panel" | "unanimous">;

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
): JurorOpinion {
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

// ── Panel aggregation (pure, testable) ───────────────────────────────────────
// A panel of jurors grades independently; the harness — never a model —
// combines the opinions. Gates: STRICT majority must pass (a tie fails —
// conservative, so prefer odd panels). Scores: per-dimension median. The
// aggregate verdict is then derived exactly like a single juror's. Every
// opinion is kept on the verdict as the record of consensus and dissent.

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

export function aggregatePanel(
  opinions: JurorOpinion[],
  rubric: Rubric,
  thresholds: { strong: number; borderline: number },
): JuryVerdict {
  if (opinions.length === 0) throw new Error("aggregatePanel: no opinions");
  if (opinions.length === 1) return opinions[0]!;
  const n = opinions.length;

  const gates: Gates = {};
  for (const g of rubric.gates) {
    gates[g] = opinions.filter((o) => o.gates[g] === true).length > n / 2;
  }
  const scores: Scores = {};
  for (const d of Object.keys(rubric.weights)) {
    scores[d] = median(opinions.map((o) => o.scores[d] ?? 0));
  }
  const weighted_total = Math.round(computeWeightedTotal(scores, rubric.weights) * 10) / 10;
  const verdict = deriveVerdict(gates, rubric.gates, weighted_total, thresholds);

  const tally = (["strong", "borderline", "reject"] as const)
    .map((v) => [v, opinions.filter((o) => o.verdict === v).length] as const)
    .filter(([, c]) => c > 0)
    .map(([v, c]) => `${c} ${v}`)
    .join(" · ");
  const unanimous = opinions.every((o) => o.verdict === opinions[0]!.verdict);
  const reservations = opinions
    .filter((o) => o.reservations)
    .map((o) => `${o.jury_model}: ${o.reservations}`)
    .join("\n");

  return {
    work_id: opinions[0]!.work_id,
    gates,
    scores,
    weighted_total,
    max_weighted: maxWeighted(rubric),
    verdict,
    references_named: uniq(opinions.flatMap((o) => o.references_named)),
    principles_invoked: uniq(opinions.flatMap((o) => o.principles_invoked)),
    rationale: `Panel of ${n} — ${tally}${unanimous ? ", unanimous" : ""}. Each juror's independent opinion is recorded.`,
    reservations: reservations || null,
    revision_suggestion: opinions.find((o) => o.revision_suggestion)?.revision_suggestion ?? null,
    jury_model: opinions.map((o) => o.jury_model).join(" + "),
    panel: opinions,
    unanimous,
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

/**
 * Grade a candidate with the configured panel (1–5 jurors, in parallel). Every
 * juror must return a usable opinion — a single failure throws, and the orphan
 * mechanism keeps the finished work re-juriable. Returns the aggregate verdict,
 * combined token usage, and the real total cost across all jurors.
 */
export async function juryCandidate(
  workId: string,
  files: GeneratedFiles,
): Promise<{ verdict: JuryVerdict; usage: Usage; costUsd: number }> {
  const cfg = loadConfig();
  const models = normalizeJuryModels(cfg.models.jury);
  const system = buildJurySystemPrompt(loadDna());
  const task = buildJuryTask(
    files,
    catalogueDigest(),
    cfg.rubric,
    Object.keys(cfg.technologies.libraries),
  );
  const run = randomUUID().slice(0, 8); // one ledger run per panel sitting
  const results = await Promise.all(
    models.map(async (model) => {
      const { content, usage } = await chat({
        model,
        system,
        user: task,
        json: true,
        temperature: 0.2,
        purpose: "jury",
        run,
      });
      const opinion = assembleVerdict(
        workId,
        parseJuryModelResponse(content, cfg.rubric),
        model,
        cfg.rubric,
        cfg.thresholds,
      );
      return { opinion, usage, costUsd: await resolveCostUsd(model, usage) };
    }),
  );
  const verdict = aggregatePanel(
    results.map((r) => r.opinion),
    cfg.rubric,
    cfg.thresholds,
  );
  const usage: Usage = {
    prompt_tokens: results.reduce((s, r) => s + r.usage.prompt_tokens, 0),
    completion_tokens: results.reduce((s, r) => s + r.usage.completion_tokens, 0),
  };
  return { verdict, usage, costUsd: results.reduce((s, r) => s + r.costUsd, 0) };
}
