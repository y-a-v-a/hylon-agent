import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { loadDna } from "./dna.ts";
import { catalogueDigest } from "./catalogue.ts";
import { loadGuidance, recentGuidance } from "./guidance.ts";
import { chat, type Usage } from "./openrouter.ts";
import { getOpenRouterPricing, usageCostUsd } from "./cost.ts";

// ── Generated metadata (the meta.json contract) ──────────────────────────────
const MetaSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  mechanism: z.string().min(1),
  principles: z.array(z.string()).min(1), // DNA principle IDs, e.g. ["P1","P5"]
  references: z.array(z.string()).min(1), // named works/artists/sources answered
  license: z.string().min(1), // as the DNA prescribes, e.g. "CC BY-SA 4.0"
});
export type GeneratedMeta = z.infer<typeof MetaSchema>;

export interface GeneratedFiles {
  html: string;
  motivation: string;
  meta: GeneratedMeta;
}

export interface GenerationResult {
  files: GeneratedFiles;
  /** Self-containment violations; empty = clean. A non-empty list is a soft fail. */
  violations: string[];
  /** Cost of this generation, USD (OpenRouter-reported, or pricing fallback). */
  costUsd: number;
}

// ── Prompt construction (pure, testable) ─────────────────────────────────────

/** The generator's operating system: the DNA, framed as its identity. */
export function buildGeneratorSystemPrompt(dna: string): string {
  return [
    "You are the GENERATOR agent for an autonomous art practice.",
    "Internalize the artistic DNA below as your operating system: it defines the",
    "identity you work in and how a work earns the right to be called 'in the DNA'.",
    "Generate works that would pass the DNA's own validation rubric.",
    "",
    "--- ARTISTIC DNA ---",
    dna,
  ].join("\n");
}

/** The three-section response contract the generator must follow. */
const OUTPUT_CONTRACT = `Return your answer as EXACTLY three sections, each introduced by its marker on a line of its own, in this order:

===META===
Strict JSON, no comments, no markdown fences:
{"title": string, "summary": string (one line), "mechanism": string (one line: the mechanism that carries the idea), "principles": string[] (DNA principle IDs), "references": string[] (named works/artists/sources), "license": string}

===MOTIVATION===
2 to 5 short paragraphs of markdown: the concept; which DNA principles it enacts (by ID); at least one named reference it answers; and how the *mechanism itself* is the argument (not decoration).

===HTML===
The complete work as a single index.html, starting with <!doctype html>. No text before or after it.`;

/** The concrete task: produce one self-contained candidate. */
export function buildGeneratorTask(digest: string, guidance = ""): string {
  return `Generate ONE new candidate artwork in the artistic DNA.

The work is a single self-contained web page. Hard requirement: FULLY SELF-CONTAINED. All CSS and JS inline. NO external requests of any kind — no external \`src=\`, no \`<link href="http...">\`, no \`@import\`, no \`url(http...)\`, no web fonts, no \`fetch\`/\`XMLHttpRequest\`/\`WebSocket\`/\`EventSource\`, no analytics, no cookies, no trackers. Visibly state the license and attribution the DNA prescribes.

Constraints:
- Must clear every hard gate of the DNA's validation rubric.
- Prefer the smallest build that completes the thought. Self-contained, client-side only.
- Commit to one strong idea. Do not ask questions.
${guidance ? `\nThe artist has given accumulated guidance from past rejections. Treat it as binding direction and heed it:\n${guidance}\n` : ""}
Do NOT duplicate any of these existing works:
${digest}

${OUTPUT_CONTRACT}`;
}

/** Task for an in-place refinement driven by the artist's feedback. */
export function buildRefineTask(feedback: string, files: GeneratedFiles): string {
  return `You previously generated the candidate artwork below (index.html, motivation.md, meta.json). The artist reviewed it and asked for this refinement:

"""
${feedback}
"""

Revise the work to address the feedback. Requirements:
- This is a REFINEMENT, not a new work — preserve the concept and identity unless the feedback explicitly asks to change it.
- Keep the page FULLY SELF-CONTAINED: all CSS/JS inline, NO external requests of any kind (no external src/href, @import, url(http), fetch, etc.).
- Update the motivation and meta only where the change affects them; keep the meta fields intact.
- Still satisfy the DNA's hard gates and stay in its voice.

=== CURRENT meta.json ===
${JSON.stringify(files.meta, null, 2)}

=== CURRENT motivation.md ===
${files.motivation}

=== CURRENT index.html ===
${files.html}

Return the COMPLETE revised files (not a diff). Do not ask questions.

${OUTPUT_CONTRACT}`;
}

// ── Response parsing (pure, testable) ────────────────────────────────────────

export interface RawSections {
  metaRaw: string;
  motivation: string;
  html: string;
}

/** Strip a single wrapping markdown fence, if the model added one. */
function stripFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/);
  return m ? m[1]!.trim() : t;
}

/**
 * Split the model's reply on the ===META=== / ===MOTIVATION=== / ===HTML===
 * markers. Tolerates prose before the first marker and fenced sections.
 */
export function parseGeneratedResponse(text: string): RawSections {
  const parts = text.split(/^===(META|MOTIVATION|HTML)===[ \t]*\r?\n/m);
  const sections: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i]!] = stripFence(parts[i + 1] ?? "");
  }
  const missing = ["META", "MOTIVATION", "HTML"].filter((k) => !sections[k]);
  if (missing.length > 0) {
    throw new Error(
      `Generator response missing section(s): ${missing.join(", ")} ` +
        `(expected ===META=== / ===MOTIVATION=== / ===HTML=== markers)`,
    );
  }
  return { metaRaw: sections.META!, motivation: sections.MOTIVATION!, html: sections.HTML! };
}

// ── Self-containment validation (pure, testable) ─────────────────────────────
// HEURISTIC FIRST PASS ONLY. This is a denylist and cannot be exhaustive; the
// real guarantee is the restrictive CSP + sandboxed iframe applied when a work
// is rendered (dashboard `/work` and the public site headers). A match here
// fails fast at generation time so we don't waste a jury call on an obvious
// violation. Note: <a href="http..."> is allowed (user-initiated license link).
const EXTERNAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "external src", re: /\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "external srcset", re: /\b(?:image)?srcset\s*=\s*["'][^"']*(?:https?:)?\/\//i },
  { name: "external <link href>", re: /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "external <base href>", re: /<base\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "css url() external", re: /url\(\s*["']?\s*(?:https?:)?\/\//i },
  { name: "@import external", re: /@import\s+(?:url\()?["']?\s*(?:https?:)?\/\//i },
  { name: "fetch()", re: /\bfetch\s*\(/i },
  { name: "dynamic import() url", re: /\bimport\s*\(\s*["'`]?\s*(?:https?:)?\/\//i },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/i },
  { name: "sendBeacon", re: /\bsendBeacon\s*\(/i },
  { name: "WebSocket", re: /\bnew\s+WebSocket\b/i },
  { name: "EventSource", re: /\bnew\s+EventSource\b/i },
  { name: "external form action", re: /\baction\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "anchor ping", re: /\bping\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "meta refresh redirect", re: /http-equiv\s*=\s*["']?\s*refresh[^>]*\burl\s*=/i },
  { name: "external object/embed data", re: /\bdata\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { name: "import map", re: /<script[^>]+type\s*=\s*["']?importmap/i },
];

/** Returns a list of self-containment violations (empty = clean). */
export function validateSelfContained(html: string): string[] {
  const violations: string[] = [];
  for (const { name, re } of EXTERNAL_PATTERNS) {
    const m = html.match(re);
    if (m) violations.push(`${name}: ${m[0].slice(0, 60)}`);
  }
  return violations;
}

// ── meta.json parsing (pure, testable) ───────────────────────────────────────
export function parseMeta(raw: string): GeneratedMeta {
  return MetaSchema.parse(JSON.parse(raw));
}

// ── File IO ──────────────────────────────────────────────────────────────────
/** Write the three candidate files into `dir` (the on-disk contract). */
export function writeGeneratedFiles(dir: string, files: GeneratedFiles): void {
  writeFileSync(join(dir, "index.html"), files.html.trim() + "\n", "utf8");
  writeFileSync(join(dir, "motivation.md"), files.motivation.trim() + "\n", "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify(files.meta, null, 2) + "\n", "utf8");
}

/** Read and validate the three candidate files from `dir`. */
export function readGeneratedFiles(dir: string): GeneratedFiles {
  const need = (name: string): string => {
    const p = join(dir, name);
    if (!existsSync(p)) throw new Error(`No ${name} in ${dir}`);
    const content = readFileSync(p, "utf8").trim();
    if (!content) throw new Error(`Empty ${name} in ${dir}`);
    return content;
  };
  const html = need("index.html");
  const motivation = need("motivation.md");
  const meta = parseMeta(need("meta.json"));
  return { html, motivation, meta };
}

// ── The generation step (integration; exercised by `npm run once` / refine) ──

/** Cost of a call: OpenRouter's reported cost, else pricing-table fallback. */
async function resolveCostUsd(model: string, usage: Usage): Promise<number> {
  if (typeof usage.costUsd === "number") return usage.costUsd;
  try {
    return usageCostUsd(await getOpenRouterPricing(model), usage);
  } catch (err) {
    // Never lose a finished work over a pricing lookup; under-count instead.
    console.error(`[generator] pricing lookup failed for ${model}: ${(err as Error).message}`);
    return 0;
  }
}

/** One OpenRouter call → parsed + validated files. */
async function runGeneration(user: string): Promise<{ files: GeneratedFiles; costUsd: number }> {
  const cfg = loadConfig();
  const { content, usage } = await chat({
    model: cfg.models.generator,
    system: buildGeneratorSystemPrompt(loadDna()),
    user,
    temperature: cfg.generation.temperature,
    maxTokens: cfg.generation.maxTokens,
  });
  const sections = parseGeneratedResponse(content);
  const files: GeneratedFiles = {
    html: sections.html,
    motivation: sections.motivation,
    meta: parseMeta(sections.metaRaw),
  };
  return { files, costUsd: await resolveCostUsd(cfg.models.generator, usage) };
}

/** Produce a fresh candidate in `workDir`. */
export async function generateCandidate(workDir: string): Promise<GenerationResult> {
  mkdirSync(workDir, { recursive: true });
  const task = buildGeneratorTask(catalogueDigest(), recentGuidance(loadGuidance()));
  const { files, costUsd } = await runGeneration(task);
  writeGeneratedFiles(workDir, files);
  return { files, violations: validateSelfContained(files.html), costUsd };
}

/** Refine the existing candidate in `dir` in place, per the artist's feedback. */
export async function refineCandidate(dir: string, feedback: string): Promise<GenerationResult> {
  if (!existsSync(dir)) throw new Error(`No candidate dir to refine: ${dir}`);
  const current = readGeneratedFiles(dir);
  const { files, costUsd } = await runGeneration(buildRefineTask(feedback, current));
  writeGeneratedFiles(dir, files);
  return { files, violations: validateSelfContained(files.html), costUsd };
}
