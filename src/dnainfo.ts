import { maxWeighted, type Rubric } from "./config.ts";
import { parseFrontmatter, type FrontmatterValue } from "./markdown.ts";
import type { Check } from "./health.ts";

// Reads an artistic DNA the way the harness depends on it: the principle ids
// both agents cite, and the §8 rubric whose SHAPE lives in agent.config.json
// (gate ids, dimensions, weights, thresholds) while its MEANING lives in the
// DNA. The template says "change one, change the other" — this module checks
// that they were. Pure and best-effort: a DNA is prose, so every extraction is
// a pattern match that degrades to "not found" rather than an error.

export interface Principle {
  id: string;
  name: string;
  text: string;
}

export interface GateInfo {
  id: string;
  /** The gate's name as the DNA defines it (e.g. "Not a duplicate"). */
  name: string | null;
  inConfig: boolean;
  /** defined = a bold `**G1 …**` entry; mentioned = the id only appears in prose. */
  status: "defined" | "mentioned" | "missing" | "extra";
}

export interface DimensionInfo {
  id: string;
  configWeight: number | null;
  /** The weight the DNA states (e.g. "weight ×3"), when it states one. */
  dnaWeight: number | null;
  status: "ok" | "unweighted" | "mismatch" | "missing" | "extra";
}

export interface ThresholdInfo {
  key: "strong" | "borderline" | "max";
  config: number;
  /** What the DNA states, when a recognizable statement exists. */
  dna: number | null;
}

export interface DnaAnalysis {
  frontmatter: Record<string, FrontmatterValue>;
  title: string;
  version: string | null;
  date: string | null;
  /** The first paragraph under an "essence" heading, if the DNA has one. */
  essence: string | null;
  /** The document still contains template placeholders. */
  isTemplate: boolean;
  stats: { lines: number; words: number; chars: number; tokens: number };
  principles: Principle[];
  gates: GateInfo[];
  dimensions: DimensionInfo[];
  thresholds: ThresholdInfo[];
  /** Coupling findings between the DNA and the config rubric. */
  checks: Check[];
}

/** Rough token estimate (≈4 characters per token for English prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LEAD = String.raw`^\s*(?:[-*+]\s+|#{2,6}\s+|\d+[.)]\s+)?`;

/** `- **P1 — Name.** text` (also `### P1 — Name`, `**P1: Name**`, …). */
export function extractPrinciples(body: string): Principle[] {
  const re = new RegExp(`${LEAD}(\\*\\*)?(P\\d{1,3})\\b(\\*\\*)?\\s*([—–:.-]*)\\s*(.*)$`);
  const out: Principle[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const isList = /^\s*([-*+]|#{2,6}|\d+[.)])\s/.test(line);
    // Unbolded, it must be a list item or heading AND read "P3 — …" / "P3: …";
    // otherwise it is a sentence that merely starts with "P3".
    if (!m[1] && !(isList && m[4])) continue;
    const id = m[2]!;
    if (out.some((p) => p.id === id)) continue;
    let rest = m[5]!.trim();
    let name = rest;
    let text = "";
    const close = rest.indexOf("**");
    if (m[1] && close >= 0) {
      name = rest.slice(0, close);
      text = rest.slice(close + 2);
    } else if (m[1] && m[3]) {
      // `**P1** — Name: text`
      const sep = rest.search(/[.:]\s/);
      name = sep >= 0 ? rest.slice(0, sep) : rest;
      text = sep >= 0 ? rest.slice(sep + 1) : "";
    }
    rest = text;
    out.push({
      id,
      name: name.replace(/[*_`]/g, "").replace(/[\s.:—–-]+$/, "").trim(),
      text: rest.replace(/^[\s:.—–-]+/, "").trim(),
    });
  }
  return out;
}

function gatePrefix(ids: string[]): string | null {
  const prefixes = new Set(ids.map((g) => g.match(/^([A-Za-z]+)\d+$/)?.[1] ?? null));
  if (prefixes.size !== 1) return null;
  return [...prefixes][0] ?? null;
}

/**
 * How a gate can be defined: a bold entry (`- **G1 Name:** …`, `**Gate G1 — Name**`),
 * a heading (`#### G1 — Name`), or a table row (`| G1 | Name | … |`). Returns
 * matchers for one id pattern, each capturing [id, name].
 */
function gateDefinitions(idPattern: string): RegExp[] {
  const id = `(?:Gate\\s+)?(${idPattern})\\b`;
  return [
    new RegExp(`${LEAD}\\*\\*${id}\\s*[—–:.-]*\\s*([^*]*?)[\\s:.]*\\*\\*`, "i"),
    new RegExp(`^\\s*#{2,6}\\s+(?:\\*\\*)?${id}(?:\\*\\*)?\\s*[—–:.-]*\\s*(.*?)\\s*#*\\s*$`, "i"),
    new RegExp(`^\\s*\\|\\s*(?:\\*\\*|\\x60)?${id}(?:\\*\\*|\\x60)?\\s*\\|\\s*([^|]*?)\\s*\\|`, "i"),
  ];
}

function cleanName(raw: string): string | null {
  const name = raw.replace(/[*_\x60]/g, "").replace(/[\s:.—–-]+$/, "").trim();
  return name || null;
}

export function extractGates(body: string, configGates: string[]): GateInfo[] {
  const lines = body.split("\n");
  const defined = (gateId: string): string | null | undefined => {
    const res = gateDefinitions(escapeRe(gateId));
    for (const line of lines) {
      for (const re of res) {
        const m = line.match(re);
        if (m && m[1]!.toUpperCase() === gateId.toUpperCase()) return cleanName(m[2]!);
      }
    }
    return undefined;
  };
  const gates: GateInfo[] = configGates.map((id) => {
    const name = defined(id);
    if (name !== undefined) return { id, name, inConfig: true, status: "defined" };
    const mentioned = new RegExp(`\\b${escapeRe(id)}\\b`).test(body);
    return { id, name: null, inConfig: true, status: mentioned ? "mentioned" : "missing" };
  });
  // Gate-shaped definitions the config doesn't know: the jury is never asked them.
  const prefix = gatePrefix(configGates);
  if (prefix) {
    const res = gateDefinitions(`${escapeRe(prefix)}\\d+`);
    for (const line of lines) {
      for (const re of res) {
        const m = line.match(re);
        if (!m) continue;
        const id = m[1]!;
        if (!configGates.some((g) => g.toUpperCase() === id.toUpperCase()) && !gates.some((g) => g.id === id)) {
          gates.push({ id, name: cleanName(m[2]!), inConfig: false, status: "extra" });
        }
        break;
      }
    }
  }
  return gates;
}

export function extractDimensions(body: string, weights: Record<string, number>): DimensionInfo[] {
  const weightOf = (dim: string): number | null => {
    const re = new RegExp(
      `\\b${escapeRe(dim)}\\b[^\\n]{0,40}?\\(\\s*(?:weight\\s*)?[×x*]\\s*(\\d+(?:\\.\\d+)?)\\s*\\)`,
      "i",
    );
    const m = body.match(re);
    return m ? Number(m[1]) : null;
  };
  const dims: DimensionInfo[] = Object.entries(weights).map(([id, w]) => {
    if (!new RegExp(`\\b${escapeRe(id)}\\b`, "i").test(body)) {
      return { id, configWeight: w, dnaWeight: null, status: "missing" };
    }
    const dnaWeight = weightOf(id);
    const status = dnaWeight === null ? "unweighted" : dnaWeight === w ? "ok" : "mismatch";
    return { id, configWeight: w, dnaWeight, status };
  });
  // `**name (weight ×N)**` entries for dimensions the config doesn't score.
  const re = /\*\*([A-Za-z][\w -]{0,30}?)\s*\(\s*weight\s*[×x*]\s*(\d+(?:\.\d+)?)\s*\)/gi;
  for (const m of body.matchAll(re)) {
    const id = m[1]!.trim();
    if (!(id in weights) && !Object.keys(weights).some((k) => k.toLowerCase() === id.toLowerCase())) {
      if (!dims.some((d) => d.id === id)) {
        dims.push({ id, configWeight: null, dnaWeight: Number(m[2]), status: "extra" });
      }
    }
  }
  return dims;
}

export function extractThresholds(
  body: string,
  thresholds: { strong: number; borderline: number },
  max: number,
): ThresholdInfo[] {
  const num = (patterns: RegExp[]): number | null => {
    for (const re of patterns) {
      const m = body.match(re);
      if (m) return Number(m[1]);
    }
    return null;
  };
  // Only unambiguous threshold statements count: "≥38 strong", "strong ≥ 38",
  // "30–37 borderline", "out of a 50 max", "max weighted total 50". Prose like
  // "Strong: 3 of the 5 dimensions" or "a maximum of 3 colours" is not one.
  return [
    {
      key: "strong",
      config: thresholds.strong,
      dna: num([/(?:≥|>=)\s*(\d+)\s*(?:=\s*)?strong\b/i, /\bstrong\s*(?:≥|>=)\s*(\d+)/i]),
    },
    {
      key: "borderline",
      config: thresholds.borderline,
      dna: num([/(\d+)\s*[–-]\s*\d+\s*(?:=\s*)?borderline\b/i, /\bborderline\s*(?:≥|>=)\s*(\d+)/i]),
    },
    {
      key: "max",
      config: max,
      dna: num([
        /out of an?\s*(\d+)\s*max\b/i,
        /\bmax(?:imum)?\s+weighted(?:\s+(?:total|score))?\s*(?:of|is|=|:)?\s*(\d+)/i,
        /\bweighted\s+total[^.\n]{0,24}?\b(?:max(?:imum)?|out of)\s*(?:of\s*)?(\d+)/i,
      ]),
    },
  ];
}

function firstParagraphUnder(body: string, heading: RegExp): string | null {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && heading.test(l));
  if (at < 0) return null;
  const para: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (line.trim() === "") {
      if (para.length) break;
      continue;
    }
    if (/^\s*>/.test(line) && para.length === 0) continue; // skip template notes
    para.push(line.trim());
  }
  return para.length ? para.join(" ") : null;
}

function str(v: FrontmatterValue | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Everything the admin console shows about a DNA, cross-checked with the rubric. */
export function analyzeDna(
  text: string,
  rubric: Rubric,
  thresholds: { strong: number; borderline: number },
): DnaAnalysis {
  const fm = parseFrontmatter(text);
  const body = fm.body;
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const principles = extractPrinciples(body);
  const gates = extractGates(body, rubric.gates);
  const dimensions = extractDimensions(body, rubric.weights);
  const max = maxWeighted(rubric);
  const thresholdInfo = extractThresholds(body, thresholds, max);

  const checks: Check[] = [];
  for (const g of gates) {
    if (g.status === "defined")
      checks.push({ level: "ok", label: `gate ${g.id} defined${g.name ? ` — ${g.name}` : ""}` });
    else if (g.status === "mentioned")
      checks.push({
        level: "warn",
        label: `gate ${g.id} is mentioned but never defined`,
        detail: `The jury must answer ${g.id} as a boolean; give it a "**${g.id} <name>:** <question>" entry in §8.1.`,
      });
    else if (g.status === "missing")
      checks.push({
        level: "fail",
        label: `gate ${g.id} is in rubric.gates but absent from the DNA`,
        detail: "The jury is asked for a gate the DNA never defines — it can only guess. Define it, or remove it from agent.config.json.",
      });
    else
      checks.push({
        level: "warn",
        label: `gate ${g.id} is defined in the DNA but not in rubric.gates`,
        detail: "The jury is never asked for it, so it cannot fail a work. Add it to agent.config.json to enforce it.",
      });
  }
  for (const d of dimensions) {
    if (d.status === "ok") checks.push({ level: "ok", label: `dimension "${d.id}" ×${d.configWeight} matches the DNA` });
    else if (d.status === "unweighted")
      checks.push({
        level: "info",
        label: `dimension "${d.id}" is described but its weight isn't stated in the DNA`,
        detail: `The harness weights it ×${d.configWeight}; stating "(weight ×${d.configWeight})" keeps the document honest.`,
      });
    else if (d.status === "mismatch")
      checks.push({
        level: "warn",
        label: `dimension "${d.id}": DNA says ×${d.dnaWeight}, config weights it ×${d.configWeight}`,
        detail: "The harness computes with the config weight. Change one, change the other.",
      });
    else if (d.status === "missing")
      checks.push({
        level: "fail",
        label: `dimension "${d.id}" is scored but never mentioned in the DNA`,
        detail: "The jury scores a dimension the DNA doesn't define.",
      });
    else
      checks.push({
        level: "warn",
        label: `dimension "${d.id}" (×${d.dnaWeight}) is in the DNA but not in rubric.weights`,
        detail: "The jury is never asked to score it.",
      });
  }
  for (const t of thresholdInfo) {
    if (t.dna !== null && t.dna !== t.config) {
      checks.push({
        level: "warn",
        label: `${t.key === "max" ? "maximum score" : `"${t.key}" threshold`}: DNA states ${t.dna}, config computes ${t.config}`,
        detail: "The verdict is computed from agent.config.json; the DNA's statement is out of date.",
      });
    }
  }
  if (principles.length === 0) {
    checks.push({
      level: "warn",
      label: "no principle ids (P1, P2, …) found",
      detail: "Both agents cite principles by id in meta.json and verdicts.",
    });
  }

  return {
    frontmatter: fm.data,
    title: str(fm.data.title) ?? h1 ?? "Artistic DNA",
    version: str(fm.data.version),
    date: str(fm.data.date),
    essence: firstParagraphUnder(body, /essence/i),
    isTemplate: /This is a TEMPLATE/.test(text) || /<your name/.test(text),
    stats: {
      lines: text.split("\n").length,
      words: text.split(/\s+/).filter(Boolean).length,
      chars: text.length,
      tokens: estimateTokens(text),
    },
    principles,
    gates,
    dimensions,
    thresholds: thresholdInfo,
    checks,
  };
}
