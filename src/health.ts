// The shared vocabulary of the admin console's findings: every subsystem
// (DNA coupling, model fitness, invariants, environment) reports Checks, and
// the overview ranks them. Pure data — rendering lives in adminview.ts.

export type Level = "ok" | "info" | "warn" | "fail";

export interface Check {
  level: Level;
  /** Short statement, e.g. "gate G4 defined in the DNA". */
  label: string;
  /** Optional explanation or remedy. */
  detail?: string;
  /** Where to look — an admin page path (e.g. "/dna#rubric"). */
  href?: string;
}

const RANK: Record<Level, number> = { ok: 0, info: 1, warn: 2, fail: 3 };

/** The most severe level among checks ("ok" when empty). */
export function worst(checks: Check[]): Level {
  return checks.reduce<Level>((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), "ok");
}

/** Most severe first; stable within a level. */
export function bySeverity(checks: Check[]): Check[] {
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => RANK[b.c.level] - RANK[a.c.level] || a.i - b.i)
    .map(({ c }) => c);
}

export function countLevels(checks: Check[]): Record<Level, number> {
  const out: Record<Level, number> = { ok: 0, info: 0, warn: 0, fail: 0 };
  for (const c of checks) out[c.level]++;
  return out;
}
