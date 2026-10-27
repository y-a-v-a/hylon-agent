import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeJuryModels, type Config } from "./config.ts";
import type { Check } from "./health.ts";
import type { Purpose } from "./usage.ts";

// Which OpenRouter model does what, and is it fit for that job? The role map
// is derived from agent.config.json exactly the way the harness resolves it
// at call time (generator.ts, jury.ts, amend.ts); fitness comes from
// OpenRouter's public model catalogue (no key needed), cached in memory and on
// disk so the admin console still answers offline.

// ── The OpenRouter catalogue ─────────────────────────────────────────────────

export interface OpenRouterModel {
  id: string;
  name?: string;
  canonical_slug?: string;
  description?: string;
  created?: number;
  context_length?: number | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  /** USD per token, as decimal strings. */
  pricing?: { prompt?: string; completion?: string; [k: string]: unknown };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
}

export interface Catalog {
  models: OpenRouterModel[];
  /** When the listing was fetched from OpenRouter (null = never). */
  fetchedAt: string | null;
  source: "live" | "cache" | "none";
  /** Why a live fetch failed, when it did. */
  error?: string;
}

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 10 * 60_000;
let catalogMemo: { catalog: Catalog; at: number } | null = null;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The catalogue: memoized for 10 minutes; on a failed fetch, the last copy
 * written to `cachePath` (marked source "cache"); else an empty "none".
 */
export async function loadCatalog(
  cachePath: string,
  opts: { fresh?: boolean; fetcher?: Fetcher; now?: number } = {},
): Promise<Catalog> {
  const now = opts.now ?? Date.now();
  if (!opts.fresh && catalogMemo && now - catalogMemo.at < CATALOG_TTL_MS) return catalogMemo.catalog;
  const fetcher = opts.fetcher ?? fetch;
  try {
    const res = await fetcher(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
    const body = (await res.json()) as { data?: OpenRouterModel[] };
    if (!Array.isArray(body.data)) throw new Error("OpenRouter /models: unexpected response shape");
    const catalog: Catalog = { models: body.data, fetchedAt: new Date(now).toISOString(), source: "live" };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: catalog.fetchedAt, data: body.data }) + "\n", "utf8");
    } catch {
      // the disk copy is a convenience; the live answer still stands
    }
    catalogMemo = { catalog, at: now };
    return catalog;
  } catch (err) {
    const error = (err as Error).message;
    if (existsSync(cachePath)) {
      try {
        const disk = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt?: string; data?: OpenRouterModel[] };
        if (Array.isArray(disk.data)) {
          const catalog: Catalog = { models: disk.data, fetchedAt: disk.fetchedAt ?? null, source: "cache", error };
          catalogMemo = { catalog, at: now - CATALOG_TTL_MS + 60_000 }; // retry live in a minute
          return catalog;
        }
      } catch {
        // unreadable cache → fall through
      }
    }
    return { models: [], fetchedAt: null, source: "none", error };
  }
}

/** Forget the memoized catalogue (tests; and `?refresh=1`). */
export function resetCatalogMemo(): void {
  catalogMemo = null;
}

/**
 * Look a configured id up in the catalogue: exact id, else canonical slug,
 * else the base id of a routing variant (`vendor/model:nitro` → `vendor/model`).
 */
export function findModel(catalog: Catalog, id: string): OpenRouterModel | undefined {
  return (
    catalog.models.find((m) => m.id === id) ??
    catalog.models.find((m) => m.canonical_slug === id) ??
    (id.includes(":") ? catalog.models.find((m) => m.id === id.slice(0, id.indexOf(":"))) : undefined)
  );
}

export interface Endpoint {
  provider_name?: string;
  tag?: string;
  quantization?: string;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  pricing?: { prompt?: string; completion?: string; discount?: number };
  supported_parameters?: string[];
  status?: number;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
}

const endpointMemo = new Map<string, { endpoints: Endpoint[]; at: number }>();

/** The upstream providers serving a model (memoized 5 minutes). */
export async function loadEndpoints(
  id: string,
  opts: { fetcher?: Fetcher; now?: number } = {},
): Promise<{ endpoints: Endpoint[]; error?: string }> {
  const now = opts.now ?? Date.now();
  const memo = endpointMemo.get(id);
  if (memo && now - memo.at < 5 * 60_000) return { endpoints: memo.endpoints };
  const base = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  if (!/^[\w.-]+\/[\w.-]+$/.test(base)) return { endpoints: [], error: "not a vendor/model id" };
  try {
    const res = await (opts.fetcher ?? fetch)(`https://openrouter.ai/api/v1/models/${base}/endpoints`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OpenRouter endpoints ${res.status}`);
    const body = (await res.json()) as { data?: { endpoints?: Endpoint[] } };
    const endpoints = body.data?.endpoints ?? [];
    endpointMemo.set(id, { endpoints, at: now });
    return { endpoints };
  } catch (err) {
    return { endpoints: [], error: (err as Error).message };
  }
}

export interface KeyInfo {
  label?: string;
  usage?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  is_free_tier?: boolean;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
}

let keyMemo: { info: KeyInfo; at: number } | null = null;

/** What OpenRouter says about the configured key (memoized 60 seconds). */
export async function loadKeyInfo(
  key: string,
  opts: { fetcher?: Fetcher; now?: number } = {},
): Promise<{ info?: KeyInfo; error?: string }> {
  const now = opts.now ?? Date.now();
  if (keyMemo && now - keyMemo.at < 60_000) return { info: keyMemo.info };
  try {
    const res = await (opts.fetcher ?? fetch)("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`OpenRouter /key ${res.status}${res.status === 401 ? " — the key was refused" : ""}`);
    const body = (await res.json()) as { data?: KeyInfo };
    const info = body.data ?? {};
    keyMemo = { info, at: now };
    return { info };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** The vendor half of an OpenRouter id: "anthropic/claude-sonnet-4.5" → "anthropic". */
export function vendorOf(id: string): string {
  const slash = id.indexOf("/");
  return (slash < 0 ? id : id.slice(0, slash)).toLowerCase();
}

/** USD per token (catalogue string) → USD per million tokens. */
export function perMillion(perToken: string | number | undefined): number | null {
  if (perToken === undefined || perToken === "") return null;
  const n = Number(perToken);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
}

export function pricing(m: OpenRouterModel | undefined): { prompt: number; completion: number } | undefined {
  const prompt = Number(m?.pricing?.prompt);
  const completion = Number(m?.pricing?.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return undefined;
  return { prompt, completion };
}

export function estimateCostUsd(
  m: OpenRouterModel | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const p = pricing(m);
  return p ? promptTokens * p.prompt + completionTokens * p.completion : null;
}

export function supports(m: OpenRouterModel, param: string): boolean {
  return (m.supported_parameters ?? []).includes(param);
}

// ── The role map ─────────────────────────────────────────────────────────────

export type RoleKey = "generator" | "jury" | "amend";

/** One model in one role, described the way the harness actually calls it. */
export interface ModelUse {
  role: RoleKey;
  /** Ledger purposes this assignment is responsible for. */
  purposes: Purpose[];
  title: string;
  model: string;
  /** Panel position, for jurors. */
  juror?: { index: number; of: number };
  /** What the model is for, in one sentence. */
  why: string;
  /** When it is called. */
  triggers: string[];
  /** What goes into its prompt. */
  reads: string[];
  call: {
    temperature: number;
    /** max_tokens sent with each call; null = the provider's default. */
    maxTokens: number | null;
    tools: boolean;
    json: boolean;
    maxTurns?: number;
  };
  /** Where in src/ the call is made. */
  code: string[];
  /** Set when the model is inherited rather than configured for the role. */
  inherited?: string;
  enabled: boolean;
}

export function modelUses(cfg: Config): ModelUse[] {
  const agentic = cfg.generation.mode === "agentic";
  const jurors = normalizeJuryModels(cfg.models.jury);
  const uses: ModelUse[] = [
    {
      role: "generator",
      purposes: ["generate", "refine"],
      title: "Generator",
      model: cfg.models.generator,
      why: agentic
        ? "Makes the work: writes index.html, motivation.md and meta.json itself with file tools, reads them back and revises until satisfied."
        : "Makes the work in one completion carrying three delimited sections (META / MOTIVATION / HTML) that the harness writes to disk.",
      triggers: [
        "every wake attempt (loop-until-pass, bounded by the time budget and $ fuse)",
        "Refine on the approval gateway — reworks a pending candidate in place from your feedback",
      ],
      reads: [
        "the artistic DNA (system prompt)",
        "the catalogue digest (do-not-duplicate list)",
        "the 20 most recent guidance entries (from your rejection notes)",
        "the technology palette",
        ...(agentic ? ["its own files, via read_file"] : []),
      ],
      call: {
        temperature: cfg.generation.temperature,
        maxTokens: cfg.generation.maxTokens,
        tools: agentic,
        json: false,
        ...(agentic ? { maxTurns: cfg.generation.maxTurns } : {}),
      },
      code: agentic
        ? ["src/generator.ts → generateCandidate / refineCandidate", "src/agentloop.ts → runAgentLoop"]
        : ["src/generator.ts → generateCandidate / refineCandidate (single-shot)"],
      enabled: true,
    },
    ...jurors.map(
      (model, index): ModelUse => ({
        role: "jury",
        purposes: ["jury"],
        title: jurors.length > 1 ? `Juror ${index + 1} of ${jurors.length}` : "Jury",
        model,
        ...(jurors.length > 1 ? { juror: { index: index + 1, of: jurors.length } } : {}),
        why:
          "Grades every candidate against the DNA's rubric — returns only gate booleans and scores as JSON. The harness computes the weighting, thresholds and verdict" +
          (jurors.length > 1 ? "; panels aggregate by strict per-gate majority and median scores." : "."),
        triggers: [
          "after every generation, before routing to pending/ or rejected/",
          "after every refinement (re-jury)",
          "Re-jury of an orphaned work",
        ],
        reads: [
          "the artistic DNA (system prompt)",
          "the catalogue digest (for the not-a-duplicate gate)",
          "the candidate's meta.json, motivation.md and index.html",
          "never the guidance file — the gate stays on the DNA alone",
        ],
        call: { temperature: 0.2, maxTokens: null, tools: false, json: true },
        code: ["src/jury.ts → juryCandidate"],
        enabled: true,
      }),
    ),
    {
      role: "amend",
      purposes: ["amend"],
      title: "Amendment drafter",
      model: cfg.amendments.model || cfg.models.generator,
      ...(cfg.amendments.model ? {} : { inherited: "amendments.model is empty, so the generator model drafts petitions" }),
      why: "Drafts a DNA amendment petition — a rationale citing your notes plus the complete revised DNA — when your recent decisions add up to a pattern. Only your ratification rewrites the DNA.",
      triggers: [
        `after each wake, once ≥ ${cfg.amendments.minSignals} new signals (rejection notes + refinement requests) have accumulated`,
        "npm run amend (forces a petition)",
      ],
      reads: [
        "the artistic DNA (system prompt)",
        "rejection notes and refinement requests since the last petition",
        "notes from petitions you declined",
      ],
      call: { temperature: 0.4, maxTokens: cfg.generation.maxTokens, tools: false, json: false },
      code: ["src/amend.ts → proposeAmendment"],
      enabled: cfg.amendments.enabled,
    },
  ];
  return uses;
}

/** Distinct model ids in use, in role order. */
export function modelsInUse(cfg: Config): string[] {
  return [...new Set(modelUses(cfg).map((u) => u.model))];
}

// ── Fitness checks (pure) ────────────────────────────────────────────────────

export interface FitnessContext {
  /** False when the catalogue couldn't be loaded at all — nothing is verifiable. */
  catalogAvailable: boolean;
  /** Estimated prompt size of one call in this role, tokens. */
  promptTokens?: number;
  now: Date;
}

/** Is this model fit for the way the harness calls it in this role? */
export function useChecks(use: ModelUse, m: OpenRouterModel | undefined, ctx: FitnessContext): Check[] {
  const checks: Check[] = [];
  if (!m) {
    if (!ctx.catalogAvailable) {
      return [{ level: "info", label: `${use.model}: not verified`, detail: "The OpenRouter catalogue is unavailable (offline?) and no cached copy exists." }];
    }
    return [
      {
        level: "fail",
        label: `${use.model} is not listed on OpenRouter`,
        detail:
          use.role === "jury"
            ? "Every wake checks the jury models first and stops before spending — no work will be made until this is fixed."
            : "The first call in this role will fail. Check the id for typos or a retired model.",
      },
    ];
  }
  if (m.id === use.model) {
    checks.push({ level: "ok", label: `listed on OpenRouter as “${m.name ?? m.id}”` });
  } else if (use.role === "jury") {
    // cost.ts getOpenRouterPricing() — the wake's pre-flight — needs the exact id.
    checks.push({
      level: "fail",
      label: `${use.model} is not an exact catalogue id (OpenRouter lists it as ${m.id})`,
      detail: `Every wake looks the jury models up by exact id before spending and stops on a miss. Configure "${m.id}".`,
    });
  } else {
    checks.push({
      level: "info",
      label: `${use.model} resolves to “${m.name ?? m.id}” (${m.id})`,
      detail: "A routing variant or dated slug; fitness below is the base model's.",
    });
  }

  if (m.expiration_date) {
    const expired = new Date(m.expiration_date).getTime() <= ctx.now.getTime();
    checks.push({
      level: expired ? "fail" : "warn",
      label: expired ? `expired on ${m.expiration_date}` : `scheduled to expire on ${m.expiration_date}`,
      detail: "Pick a successor before then — calls to an expired model fail.",
    });
  }
  if (m.architecture?.output_modalities && !m.architecture.output_modalities.includes("text")) {
    checks.push({ level: "fail", label: "does not output text", detail: `Output: ${m.architecture.output_modalities.join(", ")}` });
  }
  const params = m.supported_parameters ?? [];
  if (use.call.tools) {
    checks.push(
      params.includes("tools")
        ? { level: "ok", label: "supports tool calling (needed by the agentic loop)" }
        : {
            level: "fail",
            label: "no tool calling — the agentic generator cannot drive it",
            detail: 'Set generation.mode to "single-shot", or choose a model that lists `tools`.',
          },
    );
  }
  if (use.call.json) {
    checks.push(
      params.includes("response_format")
        ? { level: "ok", label: "supports JSON mode (response_format)" }
        : {
            level: "warn",
            label: "no JSON mode (response_format)",
            detail: "The harness still extracts the first JSON object from prose, but malformed replies strand works as orphans more often.",
          },
    );
  }
  if (params.length > 0 && !params.includes("temperature")) {
    checks.push({
      level: "warn",
      label: `temperature ${use.call.temperature} is not a supported parameter`,
      detail: "OpenRouter drops unsupported parameters; the model runs at its own default.",
    });
  }
  const maxOut = m.top_provider?.max_completion_tokens;
  if (use.call.maxTokens && maxOut && use.call.maxTokens > maxOut) {
    checks.push({
      level: "warn",
      label: `max_tokens ${use.call.maxTokens.toLocaleString("en-US")} exceeds the model's max completion (${maxOut.toLocaleString("en-US")})`,
      detail: "Lower generation.maxTokens, or providers with a smaller cap may refuse the request.",
    });
  }
  const ctxLen = m.context_length ?? m.top_provider?.context_length ?? null;
  if (ctxLen && ctx.promptTokens) {
    const share = ctx.promptTokens / ctxLen;
    const pct = `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
    if (share > 1)
      checks.push({ level: "fail", label: `prompt ≈${ctx.promptTokens.toLocaleString("en-US")} tokens exceeds the ${ctxLen.toLocaleString("en-US")}-token context` });
    else if (share > 0.8)
      checks.push({ level: "warn", label: `prompt uses ≈${pct} of the context window`, detail: "Agentic turns accumulate history on top of this." });
    else checks.push({ level: "ok", label: `prompt uses ≈${pct} of a ${ctxLen.toLocaleString("en-US")}-token context` });
  }
  if (use.model.endsWith(":free")) {
    checks.push({ level: "info", label: "free variant — heavily rate-limited, may queue or fail under load" });
  }
  return checks;
}

/** The harness's model invariants, checked against the config. */
export function invariantChecks(cfg: Config): Check[] {
  const checks: Check[] = [];
  const gen = cfg.models.generator;
  const jurors = normalizeJuryModels(cfg.models.jury);
  const genVendor = vendorOf(gen);

  const sameVendor = jurors.filter((j) => vendorOf(j) === genVendor);
  if (sameVendor.length > 0) {
    checks.push({
      level: "fail",
      label: `Two vendors, always — ${sameVendor.join(", ")} shares the generator's vendor (${genVendor})`,
      detail: "No model should grade its own vendor's output. Move the jury (or the generator) to a different vendor.",
      href: "/models#invariants",
    });
  } else {
    checks.push({
      level: "ok",
      label: `Two vendors, always — generator (${genVendor}) ≠ ${jurors.length > 1 ? "every juror" : "jury"} (${[...new Set(jurors.map(vendorOf))].join(", ")})`,
      href: "/models#invariants",
    });
  }
  for (const id of [gen, ...jurors]) {
    if (vendorOf(id) === "openrouter") {
      checks.push({
        level: "warn",
        label: `${id} is a router, not a model`,
        detail: "It may route to any vendor — including the generator's — so vendor separation can't be guaranteed.",
        href: "/models#invariants",
      });
    }
  }
  const dupes = jurors.filter((j, i) => jurors.indexOf(j) !== i);
  for (const d of new Set(dupes)) {
    checks.push({
      level: "warn",
      label: `juror ${d} sits on the panel ${jurors.filter((j) => j === d).length} times`,
      detail: "A duplicate juror votes twice with the same taste; the panel is less independent than it looks.",
      href: "/models#invariants",
    });
  }
  const vendors = jurors.map(vendorOf);
  const sharedJurorVendors = [...new Set(vendors.filter((v, i) => vendors.indexOf(v) !== i))];
  for (const v of sharedJurorVendors) {
    if (dupes.some((d) => vendorOf(d) === v)) continue;
    checks.push({
      level: "info",
      label: `several jurors come from one vendor (${v})`,
      detail: "Allowed, but a panel across vendors gives more independent opinions.",
      href: "/models#invariants",
    });
  }
  if (jurors.length > 1 && jurors.length % 2 === 0) {
    checks.push({
      level: "warn",
      label: `even panel (${jurors.length} jurors) — a tied gate fails`,
      detail: "Ties are resolved conservatively (the gate fails). Prefer 3 or 5 jurors.",
      href: "/models#invariants",
    });
  }
  if (!cfg.amendments.enabled) {
    checks.push({ level: "info", label: "amendment petitions are disabled (amendments.enabled = false)", href: "/models#amend" });
  }
  return checks;
}

// ── Roster history (pure; the git reads live in admin.ts) ────────────────────

export interface Roster {
  generator: string;
  jury: string[];
  /** "" = falls back to the generator. */
  amend: string;
}

export function rosterOf(raw: unknown): Roster | null {
  const c = raw as { models?: { generator?: unknown; jury?: unknown }; amendments?: { model?: unknown } } | null;
  const gen = c?.models?.generator;
  const jury = c?.models?.jury;
  if (typeof gen !== "string") return null;
  const juryList = typeof jury === "string" ? [jury] : Array.isArray(jury) ? jury.filter((j): j is string => typeof j === "string") : [];
  return { generator: gen, jury: juryList, amend: typeof c?.amendments?.model === "string" ? c.amendments.model : "" };
}

export interface RosterChange {
  hash: string;
  date: string;
  subject: string;
  roster: Roster;
  /** What changed relative to the previous roster (all three for the first). */
  changed: RoleKey[];
}

/**
 * Collapse config revisions (newest first) into the moments the model roster
 * actually changed (newest first). Revisions whose config doesn't parse are skipped.
 */
export function rosterTimeline(
  revs: { hash: string; date: string; subject: string; config: string }[],
): RosterChange[] {
  const out: RosterChange[] = [];
  let prev: Roster | null = null;
  for (const rev of [...revs].reverse()) {
    let roster: Roster | null = null;
    try {
      roster = rosterOf(JSON.parse(rev.config));
    } catch {
      roster = null;
    }
    if (!roster) continue;
    const changed: RoleKey[] = [];
    if (!prev || prev.generator !== roster.generator) changed.push("generator");
    if (!prev || prev.jury.join("\n") !== roster.jury.join("\n")) changed.push("jury");
    if (!prev || prev.amend !== roster.amend) changed.push("amend");
    if (changed.length > 0) out.push({ hash: rev.hash, date: rev.date, subject: rev.subject, roster, changed });
    prev = roster;
  }
  return out.reverse();
}
