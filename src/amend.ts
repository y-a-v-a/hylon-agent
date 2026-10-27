import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config, type Rubric } from "./config.ts";
import { loadDna } from "./dna.ts";
import type { CatalogueEntry } from "./catalogue.ts";
import { isValidId, isoDate } from "./ids.ts";
import { uniqueId, STATE_FILE } from "./loop.ts";
import { chat } from "./openrouter.ts";
import { CostMeter, resolveCostUsd } from "./cost.ts";
import { commitAndPush } from "./git.ts";
import { withLock } from "./lock.ts";
import { diffLines, diffStats } from "./diff.ts";

// Self-amending DNA. The artist initiates the DNA from their work SO FAR;
// their live decisions (reject-with-note, refinement requests) are signals
// that what they artistically wish may be shifting. When enough new signals
// accumulate, the agent drafts ONE focused amendment — a rationale plus the
// complete revised DNA — and files it as a PETITION at the human gate.
//
// The invariant on top of everything else: proposing is the agent's; ratifying
// is the artist's. Approval here is the ONLY code path that rewrites
// identity/DNA.md, and every petition (accepted or rejected) is archived and
// committed, so the DNA's git history is the record of a negotiated identity.

// ── Signals (pure parsers, testable) ─────────────────────────────────────────

export interface GuidanceSignal {
  date: string; // YYYY-MM-DD from the entry header
  text: string; // full entry incl. header
}

/** Parse dated `## YYYY-MM-DD — …` entries out of guidance.md. */
export function parseGuidanceEntries(text: string): GuidanceSignal[] {
  return text
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("## "))
    .map((entry) => {
      const m = entry.match(/^## (\d{4}-\d{2}-\d{2})/);
      return m ? { date: m[1]!, text: entry } : null;
    })
    .filter((x): x is GuidanceSignal => x !== null);
}

export interface RefinementSignal {
  id: string; // candidate id the feedback was about
  at: string; // ISO timestamp from the refinement log
  feedback: string;
}

/** Parse `## Refinement <ISO>` + `**Feedback:** …` entries from refinements.md. */
export function parseRefinements(md: string, id: string): RefinementSignal[] {
  const out: RefinementSignal[] = [];
  for (const block of md.split(/\n(?=## Refinement )/)) {
    const head = block.match(/^## Refinement (\S+)/);
    const fb = block.match(/\*\*Feedback:\*\* ([\s\S]*?)(?:\n\n|\n\*\*|$)/);
    if (head && fb) out.push({ id, at: head[1]!, feedback: fb[1]!.trim() });
  }
  return out;
}

export interface Signals {
  guidance: GuidanceSignal[];
  refinements: RefinementSignal[];
  published: number;
  rejected: number;
  since: string;
}

/** Everything the artist has "said" through the gate since `sinceIso`. */
export function collectSignals(cfg: Config, sinceIso: string): Signals {
  const sinceDate = sinceIso.slice(0, 10);
  const guidanceText = existsSync(cfg.abs.guidance) ? readFileSync(cfg.abs.guidance, "utf8") : "";
  const guidance = parseGuidanceEntries(guidanceText).filter((g) => g.date > sinceDate);

  const refinements: RefinementSignal[] = [];
  for (const root of [cfg.abs.pending, cfg.abs.published, cfg.abs.rejected]) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(root, e.name, "refinements.md");
      if (!existsSync(p)) continue;
      refinements.push(
        ...parseRefinements(readFileSync(p, "utf8"), e.name).filter((r) => r.at > sinceIso),
      );
    }
  }

  // Candidate ids start with their date, so the catalogue carries a timeline.
  let catalogue: CatalogueEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(cfg.abs.catalogue, "utf8")) as unknown;
    if (Array.isArray(raw)) catalogue = raw as CatalogueEntry[];
  } catch {
    // no catalogue yet — nothing decided
  }
  const decided = catalogue.filter((c) => String(c.id).slice(0, 10) > sinceDate);
  return {
    guidance,
    refinements,
    published: decided.filter((c) => c.status === "published").length,
    rejected: decided.filter((c) => c.status === "rejected").length,
    since: sinceIso,
  };
}

export function countSignals(s: Signals): number {
  return s.guidance.length + s.refinements.length;
}

// ── Prompts (pure, testable) ─────────────────────────────────────────────────

export function buildAmendSystemPrompt(dna: string): string {
  return [
    "You are the studio agent of a working artist. The artistic DNA below is the",
    "artist's operating system — initiated from their body of work so far. You have",
    "been generating candidate works in this DNA, and the artist has been accepting,",
    "rejecting, and refining them. Your role now is that of a careful archivist of",
    "the artist's evolving intent: you may petition to amend the DNA, but only the",
    "artist ratifies. You document their evolution; you never invent a new artist.",
    "",
    "--- CURRENT ARTISTIC DNA ---",
    dna,
  ].join("\n");
}

export function buildAmendTask(signals: Signals, rubric: Rubric): string {
  const guidanceBlock =
    signals.guidance.map((g) => g.text).join("\n\n") || "(no rejection notes in this period)";
  const refineBlock =
    signals.refinements
      .map((r) => `- ${r.at} · on "${r.id}": ${r.feedback}`)
      .join("\n") || "(no refinement requests in this period)";
  return `Since ${signals.since.slice(0, 10)} the artist has decided on machine-made candidates: ${signals.published} published, ${signals.rejected} rejected. These are the signals they left:

=== REJECTION NOTES (appended by the artist on reject; newest last) ===
${guidanceBlock}

=== REFINEMENT REQUESTS (the artist asking for changes to specific works) ===
${refineBlock}

Task: decide whether these signals reveal a consistent shift or clarification in what the artist artistically wishes that the current DNA does not yet capture. If — and only if — they do, draft ONE focused amendment to the DNA.

Rules:
- Be conservative. Amend only what the signals clearly support; preserve every other line of the DNA verbatim.
- Document evolution; do not invent. Cite the specific notes that justify each change.
- Do NOT rename or remove these harness-wired anchors: hard gates ${rubric.gates.join(", ")}; scored dimensions ${Object.keys(rubric.weights).join(", ")}. (Sharpening what they mean is allowed.)
- If the DNA has frontmatter with a version and date, bump them.
- If the signals are too few, too contradictory, or already captured, conclude that no amendment is warranted.

Return EXACTLY two sections, each introduced by its marker on a line of its own:

===RATIONALE===
2–5 short paragraphs: the pattern you observe (citing specific notes), what you changed and why. If you conclude no change is warranted, write the single line: NO AMENDMENT — followed by one sentence explaining why.

===DNA===
The complete revised DNA document. (If no amendment: repeat the current DNA verbatim.)`;
}

// ── Response parsing + validation (pure, testable) ───────────────────────────

export interface AmendProposal {
  rationale: string;
  dna: string;
}

export function parseAmendResponse(text: string): AmendProposal {
  const parts = text.split(/^===(RATIONALE|DNA)===[ \t]*\r?\n/m);
  const sections: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i]!] = (parts[i + 1] ?? "").trim();
  }
  const missing = ["RATIONALE", "DNA"].filter((k) => !sections[k]);
  if (missing.length > 0) {
    throw new Error(`Amendment response missing section(s): ${missing.join(", ")}`);
  }
  return { rationale: sections.RATIONALE!, dna: sections.DNA! };
}

export function isNoAmendment(rationale: string): boolean {
  return /^\s*NO AMENDMENT\b/m.test(rationale);
}

/**
 * Non-fatal review warnings for the human: rubric anchors that vanished from
 * the proposed DNA, or a suspiciously shrunken document (possible truncation).
 */
export function amendmentWarnings(current: string, proposed: string, rubric: Rubric): string[] {
  const warnings: string[] = [];
  for (const g of rubric.gates) {
    if (current.includes(g) && !proposed.includes(g)) warnings.push(`gate ${g} no longer mentioned`);
  }
  for (const d of Object.keys(rubric.weights)) {
    if (current.includes(d) && !proposed.includes(d))
      warnings.push(`scored dimension "${d}" no longer mentioned`);
  }
  if (proposed.length < current.length * 0.5) {
    warnings.push(
      `proposed DNA is ${Math.round((proposed.length / current.length) * 100)}% the size of the current one — possible truncation`,
    );
  }
  return warnings;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export interface AmendmentRecord {
  id: string;
  at: string; // ISO of the proposal
  model: string;
  /** All signals up to this moment were considered; the next petition starts here. */
  signalsThrough: string;
  signalCount: number;
  published: number;
  rejected: number;
  warnings: string[];
  diff: { added: number; removed: number };
  costUsd: number;
  status: "pending" | "accepted" | "rejected";
  decidedAt?: string;
  note?: string;
}

const RECORD_FILE = "amendment.json";
export const PROPOSAL_FILE = "proposal.md";
export const PROPOSED_DNA_FILE = "DNA.proposed.md";

function pendingRoot(cfg: Config): string {
  return join(cfg.abs.amendments, "pending");
}
function archiveRoot(cfg: Config): string {
  return join(cfg.abs.amendments, "archive");
}

export function readAmendmentRecord(dir: string): AmendmentRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, RECORD_FILE), "utf8")) as AmendmentRecord;
  } catch {
    return null;
  }
}

export interface AmendmentItem {
  id: string;
  record: AmendmentRecord;
  rationale: string;
  proposedDna: string;
}

function listIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** The pending petitions (0 or 1 by construction). */
export function listPendingAmendments(cfg: Config): AmendmentItem[] {
  if (!cfg.abs?.amendments) return []; // hermetic fixtures may omit the dir
  const items: AmendmentItem[] = [];
  for (const id of listIn(pendingRoot(cfg))) {
    const dir = join(pendingRoot(cfg), id);
    const record = readAmendmentRecord(dir);
    if (!record) continue;
    items.push({
      id,
      record,
      rationale: readFileSync(join(dir, PROPOSAL_FILE), "utf8"),
      proposedDna: readFileSync(join(dir, PROPOSED_DNA_FILE), "utf8"),
    });
  }
  return items;
}

/** Every decided petition (accepted or declined), newest first. */
export function listArchivedAmendments(cfg: Config): AmendmentItem[] {
  if (!cfg.abs?.amendments) return [];
  const items: AmendmentItem[] = [];
  for (const id of listIn(archiveRoot(cfg)).reverse()) {
    const dir = join(archiveRoot(cfg), id);
    const record = readAmendmentRecord(dir);
    if (!record) continue;
    const read = (f: string): string => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
    items.push({ id, record, rationale: read(PROPOSAL_FILE), proposedDna: read(PROPOSED_DNA_FILE) });
  }
  return items;
}

/** The moment up to which signals have already been considered by any petition. */
export function latestSignalsThrough(cfg: Config): string {
  let latest = "1970-01-01T00:00:00.000Z";
  for (const root of [pendingRoot(cfg), archiveRoot(cfg)]) {
    for (const id of listIn(root)) {
      const rec = readAmendmentRecord(join(root, id));
      if (rec && rec.signalsThrough > latest) latest = rec.signalsThrough;
    }
  }
  return latest;
}

/** Notes from past REJECTED petitions — the proposer must not re-litigate them. */
export function rejectedPetitionNotes(cfg: Config, limit = 5): string[] {
  const notes: string[] = [];
  for (const id of listIn(archiveRoot(cfg)).reverse()) {
    const rec = readAmendmentRecord(join(archiveRoot(cfg), id));
    if (rec?.status === "rejected" && rec.note) notes.push(`${rec.id}: ${rec.note}`);
    if (notes.length >= limit) break;
  }
  return notes;
}

/** The full petition task: the signals, plus the notes of petitions the artist declined. */
export function amendmentTask(cfg: Config, signals: Signals): string {
  const pastNotes = rejectedPetitionNotes(cfg);
  return (
    buildAmendTask(signals, cfg.rubric) +
    (pastNotes.length
      ? `\n\nThe artist has previously REJECTED these petitions — do not re-propose what they turned down:\n${pastNotes.map((s) => `- ${s}`).join("\n")}`
      : "")
  );
}

// ── The petition flow (integration) ──────────────────────────────────────────

export type ProposeStatus =
  | "proposed"
  | "disabled"
  | "pending-exists"
  | "below-threshold"
  | "no-signals"
  | "no-change"
  | "fuse";

export interface ProposeResult {
  status: ProposeStatus;
  id?: string;
  detail?: string;
}

/**
 * Draft a petition if the signals warrant one. Serialized via the caller
 * (daemon) or explicitly; respects the $ fuse; never touches identity/DNA.md.
 */
export async function proposeAmendment(
  opts: { force?: boolean; push?: boolean; email?: boolean; now?: Date } = {},
): Promise<ProposeResult> {
  const cfg = loadConfig();
  if (!cfg.amendments.enabled && !opts.force) return { status: "disabled" };
  if (listPendingAmendments(cfg).length > 0) return { status: "pending-exists" };

  const now = opts.now ?? new Date();
  const since = latestSignalsThrough(cfg);
  const signals = collectSignals(cfg, since);
  const n = countSignals(signals);
  if (n === 0) return { status: "no-signals" };
  if (!opts.force && n < cfg.amendments.minSignals) {
    return { status: "below-threshold", detail: `${n}/${cfg.amendments.minSignals} signals` };
  }

  const meter = new CostMeter(join(cfg.abs.root, STATE_FILE), isoDate(now), cfg.costFuse);
  const tripped = meter.tripped();
  if (tripped) return { status: "fuse", detail: tripped };

  const currentDna = loadDna();
  const model = cfg.amendments.model || cfg.models.generator;
  const { content, usage } = await chat({
    model,
    system: buildAmendSystemPrompt(currentDna),
    user: amendmentTask(cfg, signals),
    temperature: 0.4,
    maxTokens: cfg.generation.maxTokens,
    purpose: "amend",
  });
  const costUsd = await resolveCostUsd(model, usage);
  meter.add(costUsd);

  const proposal = parseAmendResponse(content);
  if (isNoAmendment(proposal.rationale) || proposal.dna.trim() === currentDna.trim()) {
    return { status: "no-change", detail: proposal.rationale.split("\n")[0] };
  }

  const id = uniqueId(
    `${isoDate(now)}-amendment`,
    (x) => existsSync(join(pendingRoot(cfg), x)) || existsSync(join(archiveRoot(cfg), x)),
  );
  const dir = join(pendingRoot(cfg), id);
  mkdirSync(dir, { recursive: true });
  const record: AmendmentRecord = {
    id,
    at: now.toISOString(),
    model,
    signalsThrough: now.toISOString(),
    signalCount: n,
    published: signals.published,
    rejected: signals.rejected,
    warnings: amendmentWarnings(currentDna, proposal.dna, cfg.rubric),
    diff: diffStats(diffLines(currentDna, proposal.dna)),
    costUsd,
    status: "pending",
  };
  writeFileSync(join(dir, PROPOSAL_FILE), proposal.rationale.trim() + "\n", "utf8");
  writeFileSync(join(dir, PROPOSED_DNA_FILE), proposal.dna.trim() + "\n", "utf8");
  writeFileSync(join(dir, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");

  await commitAndPush(`petition: ${id} (+${record.diff.added} −${record.diff.removed}, ${n} signals)`, {
    cwd: cfg.abs.root,
    remote: cfg.git.remote,
    branch: cfg.git.branch,
    push: opts.push ?? cfg.git.push,
    paths: [cfg.paths.amendments],
  });

  if (opts.email ?? !process.env.AGENT_NO_EMAIL) {
    const { sendAmendmentEmail } = await import("./notify.ts");
    try {
      await sendAmendmentEmail(id, proposal.rationale, record);
    } catch (err) {
      console.error(`[amend] email failed for ${id}: ${(err as Error).message}`);
    }
  }
  return { status: "proposed", id };
}

export type AmendmentDecision = "approve" | "reject";

/**
 * The artist's ruling on a petition. Approve is the ONLY code path in the
 * harness that rewrites identity/DNA.md. Either way the petition is archived
 * and committed — the negotiation stays on the record.
 */
export async function decideAmendment(
  id: string,
  decision: AmendmentDecision,
  opts: { note?: string; push?: boolean; now?: Date } = {},
): Promise<AmendmentRecord> {
  if (!isValidId(id)) throw new Error(`Invalid amendment id: ${id}`);
  const cfg = loadConfig();
  const src = join(pendingRoot(cfg), id);
  if (!existsSync(src)) throw new Error(`No pending amendment: ${id}`);
  const record = readAmendmentRecord(src);
  if (!record) throw new Error(`Malformed amendment record: ${id}`);
  const now = opts.now ?? new Date();

  if (decision === "approve") {
    const proposed = readFileSync(join(src, PROPOSED_DNA_FILE), "utf8");
    writeFileSync(cfg.abs.dna, proposed, "utf8");
  }

  record.status = decision === "approve" ? "accepted" : "rejected";
  record.decidedAt = now.toISOString();
  if (opts.note?.trim()) record.note = opts.note.trim();
  writeFileSync(join(src, RECORD_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");

  mkdirSync(archiveRoot(cfg), { recursive: true });
  const dest = join(archiveRoot(cfg), id);
  if (existsSync(dest)) throw new Error(`Amendment archive already exists: ${dest}`);
  renameSync(src, dest);

  await commitAndPush(
    `${decision === "approve" ? "amend" : "decline"}: ${id}${record.note ? " (+note)" : ""}`,
    {
      cwd: cfg.abs.root,
      remote: cfg.git.remote,
      branch: cfg.git.branch,
      push: opts.push ?? cfg.git.push,
      paths: [cfg.paths.amendments, cfg.paths.dna],
    },
  );
  return record;
}

// ── CLI: `npm run amend` (force a petition now) ──────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  withLock(() => proposeAmendment({ force: true }))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
