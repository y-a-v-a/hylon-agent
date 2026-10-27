import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// The usage ledger: one JSON line per OpenRouter call, appended by chatTurn()
// in openrouter.ts. Each line says WHICH model was called FOR WHAT (generate,
// refine, jury, amend), what it cost, how long it took, and which upstream
// provider served it. It is local telemetry for the admin console — gitignored
// with the other logs, never published, and never read by either agent.
//
// Writing is best-effort by design: a ledger that cannot be written logs and
// moves on, so telemetry can never fail (or bill) a generation twice.

/** What a call is for. Untagged calls are recorded as "other". */
export type Purpose = "generate" | "refine" | "jury" | "amend";

export const PURPOSES: readonly Purpose[] = ["generate", "refine", "jury", "amend"];

export interface UsageEntry {
  /** ISO time the call finished. */
  at: string;
  purpose: Purpose | "other";
  model: string;
  /** Groups the calls of one agent-loop generation or one jury panel. */
  run?: string;
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported cost in USD; null when OpenRouter didn't report one. */
  costUsd: number | null;
  /** Wall-clock latency of the HTTP exchange. */
  ms: number;
  /** The upstream provider OpenRouter routed to (e.g. "Anthropic"). */
  provider?: string;
  /** OpenRouter's generation id — look it up under openrouter.ai/activity. */
  generationId?: string;
  /** Failed calls only: the error, truncated. */
  error?: string;
}

export function appendUsage(path: string, entry: UsageEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error(`[usage] ledger write failed: ${(err as Error).message}`);
  }
}

// ── Reading (pure, testable) ─────────────────────────────────────────────────

function isEntry(x: unknown): x is UsageEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return typeof e.at === "string" && typeof e.model === "string" && typeof e.ok === "boolean";
}

/** Parse ledger text; malformed or foreign lines are skipped, never thrown on. */
export function parseUsage(text: string): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (isEntry(e)) {
        out.push({
          ...e,
          purpose: typeof e.purpose === "string" && e.purpose ? e.purpose : "other",
          ...(typeof e.provider === "string" ? {} : { provider: undefined }),
          ...(typeof e.run === "string" ? {} : { run: undefined }),
          ...(typeof e.error === "string" || e.error === undefined ? {} : { error: String(e.error) }),
          promptTokens: Number(e.promptTokens) || 0,
          completionTokens: Number(e.completionTokens) || 0,
          costUsd: typeof e.costUsd === "number" ? e.costUsd : null,
          ms: Number(e.ms) || 0,
        });
      }
    } catch {
      // a torn last line (crash mid-append) or a stray edit — skip it
    }
  }
  return out;
}

export function readUsage(path: string): UsageEntry[] {
  return existsSync(path) ? parseUsage(readFileSync(path, "utf8")) : [];
}

// ── Aggregation (pure, testable) ─────────────────────────────────────────────

/** USD per token, as the OpenRouter catalogue lists it. */
export type PriceLookup = (model: string) => { prompt: number; completion: number } | undefined;

/**
 * The cost of one entry: the reported cost when there is one, else an
 * estimate from catalogue pricing (flagged), else 0 (also flagged).
 */
export function entryCost(e: UsageEntry, price?: PriceLookup): { usd: number; estimated: boolean } {
  if (e.costUsd !== null) return { usd: e.costUsd, estimated: false };
  const p = price?.(e.model);
  if (!p) return { usd: 0, estimated: true };
  return { usd: e.promptTokens * p.prompt + e.completionTokens * p.completion, estimated: true };
}

export interface UsageSummary {
  model: string;
  purpose: string;
  calls: number;
  errors: number;
  /** Distinct runs (one agent-loop generation, one panel sitting); untagged calls count once each. */
  runs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Calls whose cost was estimated rather than reported. */
  estimatedCalls: number;
  avgMs: number;
  firstAt: string;
  lastAt: string;
  /** Upstream provider → number of calls it served. */
  providers: Record<string, number>;
}

/** One row per model × purpose, most expensive first. */
export function summarizeUsage(entries: UsageEntry[], price?: PriceLookup): UsageSummary[] {
  const groups = new Map<string, { s: UsageSummary; runs: Set<string>; msTotal: number }>();
  for (const e of entries) {
    const key = `${e.model}\u0000${e.purpose}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        s: {
          model: e.model,
          purpose: e.purpose,
          calls: 0,
          errors: 0,
          runs: 0,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          estimatedCalls: 0,
          avgMs: 0,
          firstAt: e.at,
          lastAt: e.at,
          providers: {},
        },
        runs: new Set(),
        msTotal: 0,
      };
      groups.set(key, g);
    }
    const s = g.s;
    s.calls++;
    if (!e.ok) s.errors++;
    g.runs.add(e.run ?? `call:${s.calls}`);
    s.promptTokens += e.promptTokens;
    s.completionTokens += e.completionTokens;
    const c = entryCost(e, price);
    s.costUsd += c.usd;
    if (c.estimated && e.ok) s.estimatedCalls++;
    g.msTotal += e.ms;
    if (e.at < s.firstAt) s.firstAt = e.at;
    if (e.at > s.lastAt) s.lastAt = e.at;
    if (e.provider) s.providers[e.provider] = (s.providers[e.provider] ?? 0) + 1;
  }
  return [...groups.values()]
    .map(({ s, runs, msTotal }) => ({ ...s, runs: runs.size, avgMs: s.calls ? msTotal / s.calls : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

export interface DailyUsage {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  total: number;
  calls: number;
  /** Purpose → USD spent that day. */
  byPurpose: Record<string, number>;
}

/** The last `days` UTC days ending at `now` (oldest first), zero-filled. */
export function dailyUsage(
  entries: UsageEntry[],
  days: number,
  now: Date,
  price?: PriceLookup,
): DailyUsage[] {
  const out: DailyUsage[] = [];
  const index = new Map<string, DailyUsage>();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const d: DailyUsage = { date, total: 0, calls: 0, byPurpose: {} };
    out.push(d);
    index.set(date, d);
  }
  for (const e of entries) {
    const d = index.get(e.at.slice(0, 10));
    if (!d) continue;
    const usd = entryCost(e, price).usd;
    d.total += usd;
    d.calls++;
    d.byPurpose[e.purpose] = (d.byPurpose[e.purpose] ?? 0) + usd;
  }
  return out;
}
