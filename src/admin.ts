import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadSmtp, normalizeJuryModels, parseConfig, ROOT_DIR, type Config } from "./config.ts";
import { analyzeDna, estimateTokens, type DnaAnalysis } from "./dnainfo.ts";
import { parseFrontmatter, renderMarkdown, type Rendered } from "./markdown.ts";
import { fileAt, fileHistory, fileStatus, type Revision } from "./git.ts";
import {
  amendmentTask,
  buildAmendSystemPrompt,
  collectSignals,
  countSignals,
  latestSignalsThrough,
  listArchivedAmendments,
  listPendingAmendments,
  type AmendmentItem,
  type Signals,
} from "./amend.ts";
import { catalogueDigest, type CatalogueEntry } from "./catalogue.ts";
import { recentGuidance } from "./guidance.ts";
import {
  buildGeneratorSystemPrompt,
  buildGeneratorTask,
  buildRefineTask,
  buildTechnologyNotes,
  type GeneratedFiles,
} from "./generator.ts";
import { FILE_TOOLS } from "./agentloop.ts";
import { buildJurySystemPrompt, buildJuryTask } from "./jury.ts";
import { resolveDaySpend } from "./cost.ts";
import { STATE_FILE } from "./loop.ts";
import { isoDate } from "./ids.ts";
import { bySeverity, worst, type Check } from "./health.ts";
import {
  estimateCostUsd,
  findModel,
  invariantChecks,
  loadCatalog,
  loadEndpoints,
  loadKeyInfo,
  modelUses,
  pricing,
  resetCatalogMemo,
  rosterTimeline,
  useChecks,
  type Catalog,
  type Endpoint,
  type KeyInfo,
  type ModelUse,
  type OpenRouterModel,
  type RosterChange,
} from "./models.ts";
import {
  dailyUsage,
  readUsage,
  summarizeUsage,
  type DailyUsage,
  type UsageEntry,
  type UsageSummary,
} from "./usage.ts";
import {
  collectWorks,
  jurorStats,
  lifecycleCounts,
  parseDaemonLog,
  readTail,
  rubricInPractice,
  wakeSchedule,
  type DaemonEvent,
  type JurorStat,
  type RubricPractice,
  type WakeSchedule,
  type WorkRecord,
  type WorkStatus,
} from "./insights.ts";
import * as view from "./adminview.ts";

// The admin console — the harness's third web interface, next to the approval
// gateway (dashboard.ts) and the public catalogue (site.ts). It answers two
// questions for the operator: what is the artistic DNA right now (and how did
// it get here), and which OpenRouter model does what (and is it fit for it).
//
// It is READ-ONLY by design. The DNA's invariant is that ratifying a petition
// at the gate is the only code path that rewrites identity/DNA.md, and nothing
// here may become a second one. It binds to 127.0.0.1 only: it shows
// environment details (a masked key, SMTP state) meant for the operator.

const execp = promisify(execFile);

// ── Dependencies (injectable for hermetic tests) ─────────────────────────────

export interface AdminDeps {
  /** Fresh config per request; throws when agent.config.json is invalid. */
  config: () => Config;
  catalog: (fresh: boolean) => Promise<Catalog>;
  endpoints: (id: string) => Promise<{ endpoints: Endpoint[]; error?: string }>;
  /** null when no OPENROUTER_API_KEY is set. */
  keyInfo: () => Promise<{ info?: KeyInfo; error?: string } | null>;
  /** Status and <title> of a GET to `url`, or null when nothing answers. */
  probe: (url: string) => Promise<{ status: number; title: string | null } | null>;
  /** PIDs of daemons running from `root`, or null when that can't be determined. */
  daemonPids: (root: string) => Promise<number[] | null>;
  history: (cwd: string, path: string, limit?: number) => Promise<Revision[]>;
  fileAt: (cwd: string, rev: string, path: string) => Promise<string | null>;
  fileStatus: (cwd: string, path: string) => Promise<"clean" | "modified" | "untracked" | null>;
  /** The environment the key, SMTP and AGENT_* switches are read from. */
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

export function defaultDeps(): AdminDeps {
  return {
    // Parsed fresh on every request, without resetting the shared loadConfig()
    // cache — so embedding the console in a long-lived process never changes
    // that process's view of its config.
    config: () => parseConfig(JSON.parse(readFileSync(join(ROOT_DIR, "agent.config.json"), "utf8"))),
    catalog: (fresh) => {
      if (fresh) resetCatalogMemo();
      return loadCatalog(join(ROOT_DIR, ".cache", "openrouter-models.json"), { fresh });
    },
    endpoints: (id) => loadEndpoints(id),
    keyInfo: async () => {
      const key = process.env.OPENROUTER_API_KEY?.trim();
      return key ? loadKeyInfo(key) : null;
    },
    probe: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
        const head = (await res.text()).slice(0, 4096);
        const title = head.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
        return { status: res.status, title: title === undefined ? null : decodeEntities(title) };
      } catch {
        return null;
      }
    },
    daemonPids: async (root) => {
      let pids: number[];
      try {
        const { stdout } = await execp("pgrep", ["-f", "src/daemon\\.ts"]);
        pids = stdout.split("\n").filter(Boolean).map(Number).filter((n) => n !== process.pid);
      } catch (err) {
        // pgrep exits 1 when nothing matches; anything else means "can't tell"
        return (err as { code?: number }).code === 1 ? [] : null;
      }
      // Another agent made from the same template runs the same command line;
      // only a daemon whose working directory is this repo is ours.
      const here = realpathSync(root);
      const mine: number[] = [];
      for (const pid of pids) {
        const cwd = await processCwd(pid);
        if (cwd && safe(() => realpathSync(cwd), cwd) === here) mine.push(pid);
      }
      return mine;
    },
    history: fileHistory,
    fileAt,
    fileStatus,
    env: process.env,
    now: () => new Date(),
  };
}

/** Undo escapeHtml (dashboard.ts) for a probed <title>. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A process's working directory (Linux /proc, else lsof); null when unknown. */
async function processCwd(pid: number): Promise<string | null> {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // not Linux — ask lsof
  }
  try {
    const { stdout } = await execp("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

// ── Small readers ────────────────────────────────────────────────────────────

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A config path relative to the repo root, for git and for display. */
function repoPath(cfg: Config, abs: string): string {
  return relative(cfg.abs.root, abs) || abs;
}

function readCatalogueEntries(cfg: Config): CatalogueEntry[] {
  try {
    const raw = JSON.parse(readFileSync(cfg.abs.catalogue, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as CatalogueEntry[]) : [];
  } catch {
    return [];
  }
}

export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 14) return "•".repeat(k.length);
  return `${k.slice(0, 9)}…${k.slice(-4)}`;
}

/** Mean size of a stored candidate (index.html + motivation.md + meta.json), chars. */
export function averageCandidateChars(cfg: Config): number | null {
  let total = 0;
  let n = 0;
  for (const root of [cfg.abs.pending, cfg.abs.published, cfg.abs.rejected]) {
    if (!root || !existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      let size = 0;
      for (const f of ["index.html", "motivation.md", "meta.json"]) {
        try {
          size += statSync(join(root, e.name, f)).size;
        } catch {
          // missing file — count what's there
        }
      }
      if (size > 0) {
        total += size;
        n++;
      }
    }
  }
  return n ? Math.round(total / n) : null;
}

// ── The DNA ──────────────────────────────────────────────────────────────────

export interface DnaState {
  /** Path as configured (relative to the repo). */
  path: string;
  /** What is shown: the live DNA, or the template when there is none yet. */
  source: "dna" | "template" | "none";
  text: string;
  analysis: DnaAnalysis | null;
  rendered: Rendered;
  /** Line number in `text` where the markdown body starts (after frontmatter). */
  bodyLine: number;
  gitStatus: "clean" | "modified" | "untracked" | null;
  lastChange: Revision | null;
}

export async function gatherDna(cfg: Config, deps: AdminDeps): Promise<DnaState> {
  const path = repoPath(cfg, cfg.abs.dna);
  const live = readText(cfg.abs.dna);
  const template = live === null ? readText(join(cfg.abs.root, "identity", "DNA.template.md")) : null;
  const text = live ?? template ?? "";
  const source = live !== null ? "dna" : template !== null ? "template" : "none";
  const fm = parseFrontmatter(text);
  const [status, revs] = live !== null
    ? await Promise.all([deps.fileStatus(cfg.abs.root, path), deps.history(cfg.abs.root, path, 1)])
    : [null, [] as Revision[]];
  return {
    path,
    source,
    text,
    analysis: text ? analyzeDna(text, cfg.rubric, cfg.thresholds) : null,
    rendered: renderMarkdown(fm.body),
    bodyLine: fm.bodyLine,
    gitStatus: status,
    lastChange: revs[0] ?? null,
  };
}

// ── The DNA's history ────────────────────────────────────────────────────────

/**
 * Guidance entries split exactly as recentGuidance() splits them for the
 * generator — hand-written, undated `## ` entries count toward its window too.
 */
export function guidanceEntries(text: string): { date: string | null; text: string }[] {
  return text
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("## "))
    .map((entry) => ({ date: entry.match(/^## (\d{4}-\d{2}-\d{2})/)?.[1] ?? null, text: entry }));
}

export interface GuidanceView {
  entries: { date: string | null; text: string }[];
  /** How many of the newest entries the generator actually reads. */
  window: number;
}

export interface HistoryState {
  revisions: Revision[];
  archived: AmendmentItem[];
  pending: AmendmentItem[];
  signals: Signals | null;
  signalCount: number;
  minSignals: number;
  enabled: boolean;
  guidance: GuidanceView;
}

const GUIDANCE_WINDOW = 20; // generator.ts reads recentGuidance(…, 20)

export async function gatherHistory(cfg: Config, deps: AdminDeps): Promise<HistoryState> {
  let signals: Signals | null = null;
  try {
    signals = collectSignals(cfg, latestSignalsThrough(cfg));
  } catch {
    signals = null;
  }
  return {
    revisions: await deps.history(cfg.abs.root, repoPath(cfg, cfg.abs.dna), 200),
    archived: safe(() => listArchivedAmendments(cfg), []),
    pending: safe(() => listPendingAmendments(cfg), []),
    signals,
    signalCount: signals ? countSignals(signals) : 0,
    minSignals: cfg.amendments.minSignals,
    enabled: cfg.amendments.enabled,
    guidance: { entries: guidanceEntries(readText(cfg.abs.guidance) ?? ""), window: GUIDANCE_WINDOW },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ── Prompts: exactly what each model is told ─────────────────────────────────

export interface PromptPreview {
  key: "generate" | "refine" | "jury" | "amend";
  title: string;
  models: string[];
  system: string;
  user: string;
  /** Agentic mode: the tool definitions sent with every turn. */
  tools?: string;
  /** Estimated input tokens of one call (first turn, for the agentic loop). */
  tokens: number;
  /** What the preview can't show (placeholders, accumulation). */
  note: string;
}

const PLACEHOLDER_FILES: GeneratedFiles = {
  html: "<!-- ⟨the candidate's complete index.html is inserted here⟩ -->",
  motivation: "⟨the candidate's motivation.md is inserted here⟩",
  meta: {
    title: "⟨candidate title⟩",
    summary: "⟨one-line summary⟩",
    mechanism: "⟨the mechanism that carries the idea⟩",
    principles: ["⟨principle ids⟩"],
    references: ["⟨named references⟩"],
    license: "⟨license⟩",
  },
};

export interface PromptsState {
  /** The DNA the previews were built from. */
  dnaSource: DnaState["source"];
  previews: PromptPreview[];
  /** Mean stored candidate size, used to size the jury's prompt. */
  candidateChars: number;
  candidateMeasured: boolean;
}

/** A typical candidate when none exist yet: ~24 KB of html + motivation + meta. */
const DEFAULT_CANDIDATE_CHARS = 24_000;

export function buildPrompts(cfg: Config, dnaText: string, dnaSource: DnaState["source"]): PromptsState {
  const digest = catalogueDigest(readCatalogueEntries(cfg));
  const guidance = recentGuidance(readText(cfg.abs.guidance) ?? "", GUIDANCE_WINDOW);
  const mode = cfg.generation.mode;
  const libs = Object.keys(cfg.technologies.libraries);
  const tech = buildTechnologyNotes(cfg.technologies.apis, libs);
  const tools = mode === "agentic" ? JSON.stringify(FILE_TOOLS, null, 2) : undefined;
  const measured = averageCandidateChars(cfg);
  const candidateChars = measured ?? DEFAULT_CANDIDATE_CHARS;
  const jurors = normalizeJuryModels(cfg.models.jury);

  const genSystem = buildGeneratorSystemPrompt(dnaText);
  const genTask = buildGeneratorTask(digest, guidance, mode, tech);
  const refineTask = buildRefineTask("⟨your feedback from the Refine form⟩", PLACEHOLDER_FILES, mode, tech);
  const jurySystem = buildJurySystemPrompt(dnaText);
  const juryTask = buildJuryTask(PLACEHOLDER_FILES, digest, cfg.rubric, libs);
  const amendSystem = buildAmendSystemPrompt(dnaText);
  let amendTask = "";
  try {
    amendTask = amendmentTask(cfg, collectSignals(cfg, latestSignalsThrough(cfg)));
  } catch (err) {
    amendTask = `⟨could not assemble the petition task: ${(err as Error).message}⟩`;
  }
  const toolTokens = tools ? estimateTokens(tools) : 0;

  return {
    dnaSource,
    candidateChars,
    candidateMeasured: measured !== null,
    previews: [
      {
        key: "generate",
        title: "Generate a candidate",
        models: [cfg.models.generator],
        system: genSystem,
        user: genTask,
        ...(tools ? { tools } : {}),
        tokens: estimateTokens(genSystem) + estimateTokens(genTask) + toolTokens,
        note:
          mode === "agentic"
            ? `First turn only — every later turn resends the growing history (its own files and tool results), up to ${cfg.generation.maxTurns} turns.`
            : "One completion; the reply carries the three files.",
      },
      {
        key: "refine",
        title: "Refine a pending candidate",
        models: [cfg.models.generator],
        system: genSystem,
        user: refineTask,
        ...(tools ? { tools } : {}),
        tokens: estimateTokens(genSystem) + estimateTokens(refineTask) + toolTokens + (mode === "agentic" ? 0 : estimateTokens("x".repeat(candidateChars))),
        note:
          mode === "agentic"
            ? "The candidate's files are already in the working directory; the model reads them with read_file."
            : "The candidate's current files are inlined where the placeholders are.",
      },
      {
        key: "jury",
        title: jurors.length > 1 ? `Grade a candidate (each of ${jurors.length} jurors, in parallel)` : "Grade a candidate",
        models: jurors,
        system: jurySystem,
        user: juryTask,
        tokens: estimateTokens(jurySystem) + estimateTokens(juryTask) + Math.ceil(candidateChars / 4),
        note: `The candidate's three files replace the placeholders — sized here at ${Math.round(candidateChars / 1000)} KB (${measured !== null ? "the mean of your stored works" : "a typical work; none stored yet"}). Every juror receives the identical prompt, blind to the others.`,
      },
      {
        key: "amend",
        title: "Draft a DNA amendment petition",
        models: [cfg.amendments.model || cfg.models.generator],
        system: amendSystem,
        user: amendTask,
        tokens: estimateTokens(amendSystem) + estimateTokens(amendTask),
        note: cfg.amendments.enabled
          ? `Assembled from the signals since the last petition; only sent once there are ≥ ${cfg.amendments.minSignals}.`
          : "Petitions are disabled (amendments.enabled = false); `npm run amend` still forces one.",
      },
    ],
  };
}

// ── Models ───────────────────────────────────────────────────────────────────

export interface UseView {
  use: ModelUse;
  model: OpenRouterModel | undefined;
  checks: Check[];
  /** Estimated input tokens of one call in this role. */
  promptTokens: number;
  /** ≈ USD for one call (input + a typical completion), from catalogue pricing. */
  estCallUsd: number | null;
}

export interface ModelsState {
  catalog: Pick<Catalog, "fetchedAt" | "source" | "error"> & { count: number };
  uses: UseView[];
  invariants: Check[];
  /** Distinct models in use, with their catalogue entries. */
  models: { id: string; model: OpenRouterModel | undefined; roles: ModelUse[] }[];
  usage: { entries: number; summaries: UsageSummary[]; daily: DailyUsage[]; since: string | null; failures7d: UsageEntry[] };
  jurors: JurorStat[];
  roster: RosterChange[];
  perDayFuse: number;
}

/** A typical completion per role, for the per-call estimate (tokens). */
const TYPICAL_COMPLETION: Record<ModelUse["role"], number> = { generator: 6000, jury: 600, amend: 3000 };

export async function gatherModels(
  cfg: Config,
  deps: AdminDeps,
  catalog: Catalog,
  prompts: PromptsState,
  works: WorkRecord[],
): Promise<ModelsState> {
  const now = deps.now();
  const tokensFor = (role: ModelUse["role"]): number =>
    prompts.previews.find((p) => p.key === (role === "generator" ? "generate" : role))?.tokens ?? 0;
  const uses = modelUses(cfg).map((use): UseView => {
    const model = findModel(catalog, use.model);
    const promptTokens = tokensFor(use.role);
    return {
      use,
      model,
      promptTokens,
      checks: useChecks(use, model, { catalogAvailable: catalog.source !== "none", promptTokens, now }),
      estCallUsd: estimateCostUsd(model, promptTokens, TYPICAL_COMPLETION[use.role]),
    };
  });
  const models = [...new Set(uses.map((u) => u.use.model))].map((id) => ({
    id,
    model: findModel(catalog, id),
    roles: uses.filter((u) => u.use.model === id).map((u) => u.use),
  }));

  const entries = readUsage(cfg.abs.usage);
  const price = (id: string): ReturnType<typeof pricing> => pricing(findModel(catalog, id));
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const cfgPath = "agent.config.json";
  const revs = await deps.history(cfg.abs.root, cfgPath, 60);
  const withConfig = await Promise.all(
    revs.map(async (r) => ({ ...r, config: (await deps.fileAt(cfg.abs.root, r.hash, cfgPath)) ?? "" })),
  );

  return {
    catalog: { fetchedAt: catalog.fetchedAt, source: catalog.source, error: catalog.error, count: catalog.models.length },
    uses,
    invariants: invariantChecks(cfg),
    models,
    usage: {
      entries: entries.length,
      summaries: summarizeUsage(entries, price),
      daily: dailyUsage(entries, 30, now, price),
      since: entries[0]?.at ?? null,
      failures7d: entries.filter((e) => !e.ok && e.at >= weekAgo),
    },
    jurors: jurorStats(works),
    roster: rosterTimeline(withConfig),
    perDayFuse: cfg.costFuse.perDayUsd,
  };
}

export interface ModelDetailState {
  id: string;
  model: OpenRouterModel | undefined;
  catalog: ModelsState["catalog"];
  endpoints: Endpoint[];
  endpointsError?: string;
  /** Current assignments of this model. */
  roles: ModelUse[];
  /** How it would fare in each role (as configured now). */
  fitness: { use: ModelUse; checks: Check[] }[];
  usage: UsageSummary[];
  juror: JurorStat | undefined;
  ids: string[];
}

export async function gatherModelDetail(
  cfg: Config,
  deps: AdminDeps,
  id: string,
  catalog: Catalog,
  prompts: PromptsState,
  works: WorkRecord[],
): Promise<ModelDetailState> {
  const model = findModel(catalog, id);
  const now = deps.now();
  const uses = modelUses(cfg);
  const representative: ModelUse[] = ["generator", "jury", "amend"].map(
    (role) => ({ ...uses.find((u) => u.role === role)!, model: id }),
  );
  const tokensFor = (role: ModelUse["role"]): number =>
    prompts.previews.find((p) => p.key === (role === "generator" ? "generate" : role))?.tokens ?? 0;
  const { endpoints, error } = id ? await deps.endpoints(id) : { endpoints: [], error: undefined };
  const entries = readUsage(cfg.abs.usage).filter((e) => e.model === id);
  return {
    id,
    model,
    catalog: { fetchedAt: catalog.fetchedAt, source: catalog.source, error: catalog.error, count: catalog.models.length },
    endpoints,
    ...(error ? { endpointsError: error } : {}),
    roles: uses.filter((u) => u.model === id),
    fitness: representative.map((use) => ({
      use,
      checks: useChecks(use, model, { catalogAvailable: catalog.source !== "none", promptTokens: tokensFor(use.role), now }),
    })),
    usage: summarizeUsage(entries, (m) => pricing(findModel(catalog, m))),
    juror: jurorStats(works).find((j) => j.model === id),
    ids: catalog.models.map((m) => m.id).sort(),
  };
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface DaemonState {
  pids: number[] | null;
  dashboardUrl: string;
  dashboardStatus: number | null;
  /** The <title> the configured gateway port answers with (to tell agents apart). */
  dashboardTitle: string | null;
  /** True when the gateway port answers as a different agent (e.g. "vana · pending"). */
  dashboardForeign: boolean;
  events: DaemonEvent[];
  schedule: WakeSchedule;
  errTail: string[];
  intervalHours: number;
  workBudgetMinutes: number;
}

export interface EnvState {
  key: string | null;
  keyInfo: { info?: KeyInfo; error?: string } | null;
  smtp: "configured" | "absent" | string;
  emailTo: string;
  push: boolean;
  remote: string;
  switches: Record<string, string>;
  libraries: { name: string; file: string; exists: boolean; bytes: number; inlineSafe: boolean }[];
}

export interface SpendState {
  today: number;
  perDay: number;
  perWake: number;
  last30: number;
  calls30: number;
  ledger: boolean;
}

export interface OverviewState {
  name: string;
  now: Date;
  dna: DnaState;
  history: HistoryState;
  models: ModelsState;
  works: { counts: Record<WorkStatus, number>; historical: number; pending: WorkRecord[] };
  practice: RubricPractice;
  spend: SpendState;
  daemon: DaemonState;
  env: EnvState;
  checks: Check[];
}

export function gatherEnv(cfg: Config, keyInfo: EnvState["keyInfo"], env: NodeJS.ProcessEnv): EnvState {
  const key = env.OPENROUTER_API_KEY?.trim();
  let smtp: EnvState["smtp"];
  try {
    smtp = loadSmtp(env) ? "configured" : "absent";
  } catch (err) {
    smtp = (err as Error).message;
  }
  const switches: Record<string, string> = {};
  for (const k of ["AGENT_MAX_ATTEMPTS", "AGENT_NO_PUSH", "AGENT_NO_EMAIL", "AGENT_WAKE_ON_START"]) {
    if (env[k] !== undefined) switches[k] = env[k]!;
  }
  const libraries = Object.entries(cfg.technologies.libraries).map(([name, file]) => {
    const p = resolve(cfg.abs.root, file); // as vendor.ts resolves it (absolute paths allowed)
    const src = readText(p);
    return { name, file, exists: src !== null, bytes: src?.length ?? 0, inlineSafe: src !== null && !/<\/script/i.test(src) };
  });
  return {
    key: key ? maskKey(key) : null,
    keyInfo,
    smtp,
    emailTo: cfg.email.to,
    push: cfg.git.push,
    remote: `${cfg.git.remote}/${cfg.git.branch}`,
    switches,
    libraries,
  };
}

async function gatherDaemon(cfg: Config, deps: AdminDeps): Promise<DaemonState> {
  const dashboardUrl = `http://localhost:${cfg.dashboard.port}/`;
  const [pids, probe] = await Promise.all([
    deps.daemonPids(cfg.abs.root),
    deps.probe(`http://127.0.0.1:${cfg.dashboard.port}/`),
  ]);
  // The gateway titles every page "<name> · …" (dashboard.ts); the probe decodes it.
  const dashboardForeign = Boolean(probe?.title && !probe.title.startsWith(`${cfg.name} ·`));
  const outLog = readTail(join(cfg.abs.root, "logs", "daemon.out.log"));
  const errLog = readTail(join(cfg.abs.root, "logs", "daemon.err.log"), 64 * 1024);
  // Wake errors go to stderr (console.error), so the schedule needs both logs.
  const events = parseDaemonLog(outLog, errLog);
  const errTail = errLog
    .split("\n")
    .filter((l) => l.trim())
    .slice(-8);
  return {
    pids,
    dashboardUrl,
    dashboardStatus: probe?.status ?? null,
    dashboardTitle: probe?.title ?? null,
    dashboardForeign,
    events,
    schedule: wakeSchedule(events, cfg.interval.hours),
    errTail,
    intervalHours: cfg.interval.hours,
    workBudgetMinutes: cfg.workBudget.minutes,
  };
}

/** A config error as readable lines: zod issues become "path: message". */
export function describeConfigError(err: unknown): string {
  const issues = (err as { issues?: { path?: (string | number)[]; message?: string }[] }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((i) => `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`).join("\n");
  }
  return (err as Error)?.message ?? String(err);
}

/** Read the configured admin port even from a config that doesn't validate. */
function rawAdminPort(): number {
  try {
    const port = (JSON.parse(readFileSync(join(ROOT_DIR, "agent.config.json"), "utf8")) as { admin?: { port?: unknown } })
      .admin?.port;
    return typeof port === "number" && port > 0 ? port : 4747;
  } catch {
    return 4747;
  }
}

function gatherSpend(cfg: Config, models: ModelsState, now: Date): SpendState {
  const today = resolveDaySpend(readText(join(cfg.abs.root, STATE_FILE)), isoDate(now));
  return {
    today,
    perDay: cfg.costFuse.perDayUsd,
    perWake: cfg.costFuse.perWakeUsd,
    last30: models.usage.daily.reduce((s, d) => s + d.total, 0),
    calls30: models.usage.daily.reduce((s, d) => s + d.calls, 0),
    ledger: models.usage.entries > 0,
  };
}

/** Every finding the console knows about, most severe first. */
export function collectChecks(o: Omit<OverviewState, "checks">): Check[] {
  const checks: Check[] = [];
  const { dna, history, models, spend, daemon, env, works } = o;

  if (dna.source !== "dna") {
    checks.push({
      level: "fail",
      label: `no artistic DNA at ${dna.path}`,
      detail: "Nothing can be generated or judged without it. Copy identity/DNA.template.md there and make it yours.",
      href: "/dna",
    });
  } else {
    if (dna.analysis?.isTemplate)
      checks.push({ level: "warn", label: "the DNA still contains template placeholders", detail: "Both agents will read “<your name>” and “…” as part of your identity.", href: "/dna" });
    for (const c of dna.analysis?.checks ?? []) if (c.level !== "ok") checks.push({ ...c, href: "/dna#rubric" });
    if (dna.gitStatus === "modified" || dna.gitStatus === "untracked")
      checks.push({
        level: "info",
        label: `${dna.path} has uncommitted edits`,
        detail: "Hand edits are allowed — it's your document — but they bypass the petition record until committed.",
        href: "/history",
      });
  }
  if (!env.key)
    checks.push({ level: "fail", label: "OPENROUTER_API_KEY is not set", detail: "Both agents connect with it. Set it in .env (see .env.example).", href: "/config#env" });
  else if (env.keyInfo?.error)
    checks.push({ level: "warn", label: `OpenRouter key check failed: ${env.keyInfo.error}`, href: "/config#env" });
  else if (env.keyInfo?.info?.limit_remaining !== undefined && env.keyInfo.info.limit_remaining !== null && env.keyInfo.info.limit_remaining < spend.perWake)
    checks.push({ level: "warn", label: `the key has $${env.keyInfo.info.limit_remaining.toFixed(2)} of credit limit left — less than one wake's fuse`, href: "/config#env" });

  for (const u of models.uses)
    for (const c of u.checks)
      if (c.level !== "ok") checks.push({ ...c, label: `${u.use.title} (${u.use.model}): ${c.label}`, href: "/models#use-" + u.use.role });
  for (const c of models.invariants) if (c.level !== "ok") checks.push(c);
  if (models.catalog.source === "none")
    checks.push({ level: "info", label: "the OpenRouter catalogue is unavailable — model fitness can't be verified", detail: models.catalog.error, href: "/models" });
  else if (models.catalog.source === "cache")
    checks.push({ level: "info", label: `using the cached OpenRouter catalogue from ${models.catalog.fetchedAt?.slice(0, 10) ?? "an unknown date"}`, detail: models.catalog.error, href: "/models" });

  const failures = models.usage.failures7d;
  if (failures.length > 0) {
    const byModel = new Map<string, number>();
    for (const f of failures) byModel.set(`${f.model} (${f.purpose})`, (byModel.get(`${f.model} (${f.purpose})`) ?? 0) + 1);
    checks.push({
      level: "warn",
      label: `${failures.length} failed OpenRouter call${failures.length === 1 ? "" : "s"} in the last 7 days`,
      detail: [...byModel].map(([k, n]) => `${k}: ${n}`).join(" · ") + ` — last: ${failures.at(-1)!.error ?? "unknown error"}`,
      href: "/models#usage",
    });
  }
  for (const lib of env.libraries) {
    if (!lib.exists) checks.push({ level: "fail", label: `vendored library “${lib.name}” is declared but ${lib.file} is missing`, detail: "Every generation stops before spending until it is pinned (see vendor/README.md).", href: "/config#libraries" });
    else if (!lib.inlineSafe) checks.push({ level: "fail", label: `vendored library “${lib.name}” contains "</script>" and can't be inlined`, href: "/config#libraries" });
  }
  if (spend.today >= spend.perDay)
    checks.push({ level: "warn", label: `today's daily fuse is spent ($${spend.today.toFixed(2)} of $${spend.perDay})`, detail: "No new work until tomorrow (UTC).", href: "/models#usage" });
  else if (spend.today >= spend.perDay * 0.8)
    checks.push({ level: "info", label: `${Math.round((spend.today / spend.perDay) * 100)}% of today's fuse is spent`, href: "/models#usage" });

  if (history.pending.length > 0)
    checks.push({ level: "info", label: "a DNA amendment petition awaits your ratification", detail: "Decide it on the approval gateway.", href: "/history" });
  if (works.counts.orphaned > 0)
    checks.push({ level: "warn", label: `${works.counts.orphaned} orphaned work${works.counts.orphaned === 1 ? "" : "s"} never reached a verdict`, detail: "Re-jury them from the approval gateway.", href: daemon.dashboardUrl });
  if (works.counts.pending > 0)
    checks.push({ level: "info", label: `${works.counts.pending} candidate${works.counts.pending === 1 ? "" : "s"} await${works.counts.pending === 1 ? "s" : ""} your decision`, href: daemon.dashboardUrl });
  if (daemon.dashboardForeign)
    checks.push({
      level: "warn",
      label: `the gateway port ${daemon.dashboardUrl.match(/:(\d+)\//)?.[1] ?? ""} is answered by another agent (“${daemon.dashboardTitle}”)`,
      detail: `Agents made from the same template share the default dashboard.port. Give ${o.name} its own port in agent.config.json, or its daemon can't serve the gateway. (A daemon started before a rename also answers with its old name until restarted.)`,
      href: "/#daemon",
    });
  if (daemon.pids?.length && daemon.schedule.intervalFromLog && daemon.schedule.intervalHours !== daemon.intervalHours)
    checks.push({
      level: "info",
      label: `the daemon runs with interval ${daemon.schedule.intervalHours} h; agent.config.json now says ${daemon.intervalHours} h`,
      detail: "The daemon reads its config once, at start-up — restart it to apply (npm run daemon:restart).",
      href: "/#daemon",
    });
  if (daemon.pids !== null && daemon.pids.length === 0)
    checks.push({ level: "info", label: "the daemon is not running — no scheduled wakes", detail: "npm start, or npm run daemon:install && npm run daemon:start (see ops/DAEMON.md).", href: "/#daemon" });
  if (daemon.errTail.length > 0 && daemon.pids?.length)
    checks.push({ level: "info", label: "the daemon's error log has entries", detail: daemon.errTail.at(-1), href: "/#daemon" });
  return bySeverity(checks);
}

export async function gatherOverview(cfg: Config, deps: AdminDeps, fresh = false): Promise<OverviewState> {
  const now = deps.now();
  const [dna, history, catalog, keyInfo, daemon] = await Promise.all([
    gatherDna(cfg, deps),
    gatherHistory(cfg, deps),
    deps.catalog(fresh),
    deps.keyInfo(),
    gatherDaemon(cfg, deps),
  ]);
  const works = collectWorks(cfg);
  const prompts = buildPrompts(cfg, dna.text, dna.source);
  const models = await gatherModels(cfg, deps, catalog, prompts, works);
  const env = gatherEnv(cfg, keyInfo, deps.env);
  const counts = lifecycleCounts(works);
  const base = {
    name: cfg.name,
    now,
    dna,
    history,
    models,
    works: {
      counts,
      historical: readCatalogueEntries(cfg).filter((e) => e.status === "historical").length,
      pending: works.filter((w) => w.status === "pending"),
    },
    practice: rubricInPractice(works, cfg.rubric),
    spend: gatherSpend(cfg, models, now),
    daemon,
    env,
  };
  return { ...base, checks: collectChecks(base) };
}

// ── Server ───────────────────────────────────────────────────────────────────

// The console only renders its own escaped markup; this CSP is a backstop.
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...(type.startsWith("text/html") ? { "Content-Security-Policy": PAGE_CSP } : {}),
  });
  res.end(body);
}

const html = (res: ServerResponse, body: string, status = 200): void => send(res, status, "text/html; charset=utf-8", body);
const json = (res: ServerResponse, data: unknown): void =>
  send(res, 200, "application/json; charset=utf-8", JSON.stringify(data, null, 2) + "\n");

/**
 * True for a Host header naming this machine. Binding to 127.0.0.1 keeps the
 * network out, but not a web page whose domain re-resolves to 127.0.0.1 (DNS
 * rebinding); refusing foreign Host headers closes that door.
 */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".localhost");
}

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (!isLocalHost(req.headers?.host)) {
    res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
    return void res.end("The admin console answers on localhost only.\n");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    return void res.end("The admin console is read-only.\n");
  }
  if (path === "/favicon.ico") {
    res.writeHead(204);
    return void res.end();
  }

  let cfg: Config;
  try {
    cfg = deps.config();
  } catch (err) {
    return html(res, view.renderConfigError(describeConfigError(err), readText(join(ROOT_DIR, "agent.config.json"))), 500);
  }
  const chrome = { name: cfg.name, gateway: `http://localhost:${cfg.dashboard.port}/`, now: deps.now() };
  const fresh = url.searchParams.get("refresh") === "1";

  switch (path) {
    case "/": {
      const o = await gatherOverview(cfg, deps, fresh);
      return html(res, view.renderOverview(o, chrome, cfg));
    }
    case "/api/overview.json": {
      const { dna, ...o } = await gatherOverview(cfg, deps, fresh);
      const { rendered, text, ...dnaRest } = dna;
      return json(res, { ...o, dna: dnaRest });
    }
    case "/dna": {
      const [dna, history] = await Promise.all([gatherDna(cfg, deps), gatherHistory(cfg, deps)]);
      const works = collectWorks(cfg);
      return html(res, view.renderDnaPage(dna, rubricInPractice(works, cfg.rubric), works, history, chrome, cfg));
    }
    case "/dna.md": {
      const text = readText(cfg.abs.dna);
      if (text === null) return send(res, 404, "text/plain; charset=utf-8", `No DNA at ${cfg.paths.dna}\n`);
      return send(res, 200, "text/plain; charset=utf-8", text);
    }
    case "/api/dna.json": {
      const dna = await gatherDna(cfg, deps);
      return json(res, { path: dna.path, source: dna.source, gitStatus: dna.gitStatus, lastChange: dna.lastChange, analysis: dna.analysis, headings: dna.rendered.headings, text: dna.text });
    }
    case "/history": {
      const [dna, history] = await Promise.all([gatherDna(cfg, deps), gatherHistory(cfg, deps)]);
      return html(res, view.renderHistory(history, dna, chrome));
    }
    case "/models": {
      const [dna, catalog] = await Promise.all([gatherDna(cfg, deps), deps.catalog(fresh)]);
      const works = collectWorks(cfg);
      const models = await gatherModels(cfg, deps, catalog, buildPrompts(cfg, dna.text, dna.source), works);
      return html(res, view.renderModels(models, chrome, cfg));
    }
    case "/api/models.json": {
      const [dna, catalog] = await Promise.all([gatherDna(cfg, deps), deps.catalog(fresh)]);
      const models = await gatherModels(cfg, deps, catalog, buildPrompts(cfg, dna.text, dna.source), collectWorks(cfg));
      return json(res, models);
    }
    case "/model": {
      const id = (url.searchParams.get("id") ?? "").trim();
      const [dna, catalog] = await Promise.all([gatherDna(cfg, deps), deps.catalog(fresh)]);
      const detail = await gatherModelDetail(cfg, deps, id, catalog, buildPrompts(cfg, dna.text, dna.source), collectWorks(cfg));
      return html(res, view.renderModelDetail(detail, chrome));
    }
    case "/prompts": {
      const [dna, catalog] = await Promise.all([gatherDna(cfg, deps), deps.catalog(false)]);
      return html(res, view.renderPrompts(buildPrompts(cfg, dna.text, dna.source), catalog, chrome));
    }
    case "/config": {
      const env = gatherEnv(cfg, await deps.keyInfo(), deps.env);
      return html(res, view.renderConfig(cfg, readText(join(cfg.abs.root, "agent.config.json")), env, chrome));
    }
  }

  const rev = path.match(/^\/history\/([0-9a-f]{7,40})$/);
  if (rev) {
    const hash = rev[1]!;
    const dnaPath = repoPath(cfg, cfg.abs.dna);
    const [then, history] = await Promise.all([deps.fileAt(cfg.abs.root, hash, dnaPath), deps.history(cfg.abs.root, dnaPath, 200)]);
    const revision = history.find((r) => r.hash.startsWith(hash));
    if (then === null || !revision) return html(res, view.renderNotFound(chrome, `No version of ${dnaPath} at ${hash}.`), 404);
    return html(res, view.renderRevision(revision, then, readText(cfg.abs.dna) ?? "", history, chrome));
  }

  html(res, view.renderNotFound(chrome), 404);
}

export function startAdmin(): ReturnType<typeof createServer> {
  const deps = defaultDeps();
  // An invalid config must not keep the console down — it renders the
  // validation error, which is exactly when the operator needs it.
  let port: number;
  try {
    port = deps.config().admin.port;
  } catch (err) {
    port = rawAdminPort();
    console.error(`[admin] agent.config.json does not validate — serving the error page:\n  ${describeConfigError(err).split("\n").join("\n  ")}`);
  }
  const server = createServer((req, res) => {
    handleAdmin(req, res, deps).catch((err) => {
      console.error(`[admin] ${req.url}: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", `Error: ${(err as Error).message}\n`);
      else res.end();
    });
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.error(
      `[admin] port ${port} is already in use — set "admin": { "port": … } in agent.config.json to choose another.`,
    );
    process.exit(1);
  });
  // Loopback only — see the header comment.
  server.listen(port, "127.0.0.1", () => {
    console.log(`[admin] http://localhost:${port} (read-only, bound to 127.0.0.1)`);
  });
  return server;
}

// CLI: `npm run admin`
if (import.meta.url === `file://${process.argv[1]}`) {
  startAdmin();
}
