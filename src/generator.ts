import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { loadDna } from "./dna.ts";
import { catalogueDigest } from "./catalogue.ts";
import { loadGuidance, recentGuidance } from "./guidance.ts";
import { chat } from "./openrouter.ts";
import { runAgentLoop } from "./agentloop.ts";
import { resolveCostUsd } from "./cost.ts";
import { ensureVendorFiles, validateVendorPlaceholders } from "./vendor.ts";
import type { Purpose } from "./usage.ts";

export type GenerationMode = "agentic" | "single-shot";

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

export const REQUIRED_FILES = ["index.html", "motivation.md", "meta.json"];

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

// ── Technology palette (pure, testable) ──────────────────────────────────────
// Human-readable labels + practical notes for the known API names. Unknown
// names pass through as-is, so the palette is open-ended.
const API_LABELS: Record<string, string> = {
  svg: "inline SVG",
  "canvas-2d": "Canvas 2D",
  webgl: "WebGL",
  webaudio: "Web Audio API (audio must start from a user gesture — browsers block autoplay)",
  "css-animation": "CSS animations/transitions",
  "web-animations": "Web Animations API",
};

/**
 * The "materials" paragraph for the generator prompt: which browser APIs are
 * in bounds and which vendored libraries may be pulled in via placeholder.
 * Returns "" when the palette is empty (the prompt omits the section).
 */
export function buildTechnologyNotes(apis: string[], libraries: string[]): string {
  if (apis.length === 0 && libraries.length === 0) return "";
  const lines = ["Materials available to you (use what the idea needs, nothing more):"];
  if (apis.length > 0) {
    lines.push(`- Browser APIs: ${apis.map((a) => API_LABELS[a] ?? a).join(", ")}.`);
  }
  for (const name of libraries) {
    lines.push(
      `- Vendored library "${name}": to use it, place exactly <script data-vendor="${name}"></script> where the library must load. The harness replaces that tag with the full library source when the work is rendered — do NOT add a src attribute and do NOT paste the library code yourself.`,
    );
  }
  lines.push(
    "Everything must still run with zero external requests — the palette never overrides self-containment.",
  );
  return lines.join("\n");
}

/** The shared description of the three files every candidate consists of. */
const FILES_SPEC = `1. **index.html** — the work itself, a complete page starting with <!doctype html>.

2. **motivation.md** — 2 to 5 short paragraphs of markdown: the concept; which DNA principles it enacts (by ID); at least one named reference it answers; and how the *mechanism itself* is the argument (not decoration).

3. **meta.json** — strict JSON, no comments:
   {"title": string, "summary": string (one line), "mechanism": string (one line: the mechanism that carries the idea), "principles": string[] (DNA principle IDs), "references": string[] (named works/artists/sources), "license": string}`;

/** Agentic mode: the model writes the files itself with its tools. */
const TOOL_CONTRACT = `You have file tools (write_file, read_file, list_files) scoped to your working directory. Produce the candidate as exactly three files:

${FILES_SPEC}

Work like an artist with a studio: write the files, read your work back, and revise until it is right. When all three files are written and you are satisfied, reply WITHOUT tool calls, with a one-paragraph summary. Do not create unrelated files.`;

/** Single-shot mode: the reply itself carries the three delimited sections. */
const OUTPUT_CONTRACT = `Return your answer as EXACTLY three sections, each introduced by its marker on a line of its own, in this order — they correspond to these three files:

${FILES_SPEC}

===META===
(the strict JSON for meta.json)

===MOTIVATION===
(the markdown for motivation.md)

===HTML===
(the complete index.html, starting with <!doctype html>. No text before or after it.)`;

/** The concrete task: produce one self-contained candidate. */
export function buildGeneratorTask(
  digest: string,
  guidance = "",
  mode: GenerationMode = "agentic",
  techNotes = "",
): string {
  return `Generate ONE new candidate artwork in the artistic DNA.

The work is a single self-contained web page. Hard requirement: FULLY SELF-CONTAINED. All CSS and JS inline. NO external requests of any kind — no external \`src=\`, no \`<link href="http...">\`, no \`@import\`, no \`url(http...)\`, no web fonts, no \`fetch\`/\`XMLHttpRequest\`/\`WebSocket\`/\`EventSource\`, no analytics, no cookies, no trackers. Visibly state the license and attribution the DNA prescribes.
${techNotes ? `\n${techNotes}\n` : ""}
Constraints:
- Must clear every hard gate of the DNA's validation rubric.
- Prefer the smallest build that completes the thought. Self-contained, client-side only.
- Commit to one strong idea. Do not ask questions.
${guidance ? `\nThe artist has given accumulated guidance from past rejections. Treat it as binding direction and heed it:\n${guidance}\n` : ""}
Do NOT duplicate any of these existing works:
${digest}

${mode === "agentic" ? TOOL_CONTRACT : OUTPUT_CONTRACT}`;
}

/** Task for an in-place refinement driven by the artist's feedback. */
export function buildRefineTask(
  feedback: string,
  files: GeneratedFiles,
  mode: GenerationMode = "agentic",
  techNotes = "",
): string {
  const requirements = `Revise the work to address the feedback. Requirements:
- This is a REFINEMENT, not a new work — preserve the concept and identity unless the feedback explicitly asks to change it.
- Keep the page FULLY SELF-CONTAINED: all CSS/JS inline, NO external requests of any kind (no external src/href, @import, url(http), fetch, etc.).
- Update the motivation and meta only where the change affects them; keep the meta fields intact.
- Still satisfy the DNA's hard gates and stay in its voice.${techNotes ? `\n\n${techNotes}` : ""}`;

  if (mode === "agentic") {
    return `The current working directory holds the candidate artwork you previously generated (index.html, motivation.md, meta.json). The artist reviewed it and asked for this refinement:

"""
${feedback}
"""

${requirements}

Read the current files first, then rewrite them in place with write_file (always the complete file). When done, reply WITHOUT tool calls, with a one-paragraph summary of what you changed. Do not create unrelated files and do not ask questions.`;
  }

  return `You previously generated the candidate artwork below (index.html, motivation.md, meta.json). The artist reviewed it and asked for this refinement:

"""
${feedback}
"""

${requirements}

=== CURRENT meta.json ===
${JSON.stringify(files.meta, null, 2)}

=== CURRENT motivation.md ===
${files.motivation}

=== CURRENT index.html ===
${files.html}

Return the COMPLETE revised files (not a diff). Do not ask questions.

${OUTPUT_CONTRACT}`;
}

// ── Response parsing for single-shot mode (pure, testable) ───────────────────

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

/** Agentic mode: run the file-tool loop in `workDir`, then validate the files. */
async function runAgentic(
  workDir: string,
  task: string,
  purpose: Purpose,
): Promise<{ files: GeneratedFiles; costUsd: number }> {
  const cfg = loadConfig();
  const { costUsd } = await runAgentLoop({
    model: cfg.models.generator,
    system: buildGeneratorSystemPrompt(loadDna()),
    task,
    workDir,
    requiredFiles: REQUIRED_FILES,
    maxTurns: cfg.generation.maxTurns,
    temperature: cfg.generation.temperature,
    maxTokens: cfg.generation.maxTokens,
    purpose,
  });
  return { files: readGeneratedFiles(workDir), costUsd };
}

/** Single-shot mode: one call whose reply carries the three sections. */
async function runSingleShot(
  workDir: string,
  task: string,
  purpose: Purpose,
): Promise<{ files: GeneratedFiles; costUsd: number }> {
  const cfg = loadConfig();
  const { content, usage } = await chat({
    model: cfg.models.generator,
    system: buildGeneratorSystemPrompt(loadDna()),
    user: task,
    temperature: cfg.generation.temperature,
    maxTokens: cfg.generation.maxTokens,
    purpose,
  });
  const sections = parseGeneratedResponse(content);
  const files: GeneratedFiles = {
    html: sections.html,
    motivation: sections.motivation,
    meta: parseMeta(sections.metaRaw),
  };
  writeGeneratedFiles(workDir, files);
  return { files, costUsd: await resolveCostUsd(cfg.models.generator, usage) };
}

/** The configured palette as prompt notes; fails fast on broken vendor files. */
function techNotesFromConfig(cfg: ReturnType<typeof loadConfig>): string {
  ensureVendorFiles(cfg); // never spend on a generation whose libraries can't render
  return buildTechnologyNotes(cfg.technologies.apis, Object.keys(cfg.technologies.libraries));
}

/** Self-containment plus vendored-placeholder validation. */
function allViolations(cfg: ReturnType<typeof loadConfig>, html: string): string[] {
  return [
    ...validateSelfContained(html),
    ...validateVendorPlaceholders(html, Object.keys(cfg.technologies.libraries)),
  ];
}

/** Produce a fresh candidate in `workDir`. */
export async function generateCandidate(workDir: string): Promise<GenerationResult> {
  mkdirSync(workDir, { recursive: true });
  const cfg = loadConfig();
  const mode = cfg.generation.mode;
  const task = buildGeneratorTask(
    catalogueDigest(),
    recentGuidance(loadGuidance()),
    mode,
    techNotesFromConfig(cfg),
  );
  const { files, costUsd } =
    mode === "agentic"
      ? await runAgentic(workDir, task, "generate")
      : await runSingleShot(workDir, task, "generate");
  return { files, violations: allViolations(cfg, files.html), costUsd };
}

/** Refine the existing candidate in `dir` in place, per the artist's feedback. */
export async function refineCandidate(dir: string, feedback: string): Promise<GenerationResult> {
  if (!existsSync(dir)) throw new Error(`No candidate dir to refine: ${dir}`);
  const cfg = loadConfig();
  const mode = cfg.generation.mode;
  const current = readGeneratedFiles(dir); // also validates before we touch anything
  const task = buildRefineTask(feedback, current, mode, techNotesFromConfig(cfg));
  const { files, costUsd } =
    mode === "agentic" ? await runAgentic(dir, task, "refine") : await runSingleShot(dir, task, "refine");
  return { files, violations: allViolations(cfg, files.html), costUsd };
}
