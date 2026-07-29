import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Usage } from "./openrouter.ts";

// ── OpenRouter per-model pricing (integration; cached in-memory) ──────────────
export interface ModelPricing {
  prompt: number; // USD per prompt token
  completion: number; // USD per completion token
}

const pricingCache = new Map<string, ModelPricing>();

export async function getOpenRouterPricing(model: string): Promise<ModelPricing> {
  const cached = pricingCache.get(model);
  if (cached) return cached;
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
  const data = (await res.json()) as {
    data: { id: string; pricing: { prompt: string; completion: string } }[];
  };
  const m = data.data.find((x) => x.id === model);
  if (!m) throw new Error(`Model not found on OpenRouter: ${model}`);
  const pricing: ModelPricing = {
    prompt: Number(m.pricing.prompt),
    completion: Number(m.pricing.completion),
  };
  pricingCache.set(model, pricing);
  return pricing;
}

// ── Pure cost/fuse helpers ───────────────────────────────────────────────────
export function usageCostUsd(pricing: ModelPricing, usage: Usage): number {
  // Prefer the provider-reported cost when OpenRouter included it.
  if (typeof usage.costUsd === "number") return usage.costUsd;
  return usage.prompt_tokens * pricing.prompt + usage.completion_tokens * pricing.completion;
}

export interface CostFuse {
  perWakeUsd: number;
  perDayUsd: number;
}

/**
 * Returns a fuse-trip reason if either ceiling is reached, else null.
 * Checked BEFORE each attempt, so we never start work we can't afford.
 */
export function fuseCheck(wakeUsd: number, dayUsd: number, fuse: CostFuse): string | null {
  if (dayUsd >= fuse.perDayUsd) return `daily cap $${fuse.perDayUsd} reached ($${dayUsd.toFixed(3)})`;
  if (wakeUsd >= fuse.perWakeUsd) return `per-wake cap $${fuse.perWakeUsd} reached ($${wakeUsd.toFixed(3)})`;
  return null;
}

interface DayState {
  date: string;
  spentUsd: number;
}

/** Resolve carried-over daily spend: same UTC day accumulates, a new day resets. */
export function resolveDaySpend(raw: string | null, today: string): number {
  if (!raw) return 0;
  try {
    const s = JSON.parse(raw) as Partial<DayState>;
    return s.date === today && typeof s.spentUsd === "number" ? s.spentUsd : 0;
  } catch {
    return 0;
  }
}

// ── Stateful meter (persists daily spend across wakes) ───────────────────────
export class CostMeter {
  private wakeUsd = 0;
  private dayUsd: number;

  constructor(
    private readonly statePath: string,
    private readonly today: string,
    private readonly fuse: CostFuse,
  ) {
    this.dayUsd = resolveDaySpend(
      existsSync(statePath) ? readFileSync(statePath, "utf8") : null,
      today,
    );
  }

  add(usd: number): void {
    this.wakeUsd += usd;
    this.dayUsd += usd;
    writeFileSync(
      this.statePath,
      JSON.stringify({ date: this.today, spentUsd: this.dayUsd }, null, 2) + "\n",
      "utf8",
    );
  }

  wakeSpent(): number {
    return this.wakeUsd;
  }
  daySpent(): number {
    return this.dayUsd;
  }

  /** Fuse-trip reason, or null if there's budget to start another attempt. */
  tripped(): string | null {
    return fuseCheck(this.wakeUsd, this.dayUsd, this.fuse);
  }
}
