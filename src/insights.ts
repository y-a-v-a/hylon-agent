import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Rubric } from "./config.ts";
import { validateSelfContained, type GeneratedMeta } from "./generator.ts";
import type { JurorOpinion, JuryVerdict, Verdict } from "./jury.ts";
import { validateVendorPlaceholders } from "./vendor.ts";

// What the record says happened: every jury.json in the lifecycle dirs, read
// back to show how each juror model has actually behaved — its verdicts, how
// often it dissents from its panel, and how often it agrees with the artist's
// own decisions at the gate. Plus the daemon's log, for "is it alive and when
// does it wake next". Read-only and tolerant: a malformed dir is skipped.

export type WorkStatus = "pending" | "published" | "rejected" | "orphaned";

export interface WorkRecord {
  id: string;
  status: WorkStatus;
  title: string;
  verdict: JuryVerdict | null;
  /**
   * Who settled the work's fate: the artist (approved, or rejected a work the
   * jury passed), the jury/harness (routed to rejected/), or nobody yet.
   */
  decidedBy: "artist" | "machine" | "open";
  violations: string[];
  rejectionNote: boolean;
  refinements: number;
}

/** Just enough shape to chart and count a verdict; anything else is treated as absent. */
function isVerdict(v: unknown): v is JuryVerdict {
  const x = v as Partial<JuryVerdict> | null;
  return (
    !!x &&
    typeof x.weighted_total === "number" &&
    typeof x.max_weighted === "number" &&
    (x.verdict === "strong" || x.verdict === "borderline" || x.verdict === "reject") &&
    typeof x.jury_model === "string" &&
    (x.panel === undefined || (Array.isArray(x.panel) && x.panel.every((o) => isVerdict(o))))
  );
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every work the harness has made, newest id first. */
export function collectWorks(cfg: Config): WorkRecord[] {
  const roots: [WorkStatus, string][] = [
    ["pending", cfg.abs.pending],
    ["published", cfg.abs.published],
    ["rejected", cfg.abs.rejected],
    ["orphaned", cfg.abs.orphaned],
  ];
  const declared = Object.keys(cfg.technologies?.libraries ?? {});
  const works: WorkRecord[] = [];
  for (const [status, root] of roots) {
    if (!root || !existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(root, e.name);
      const meta = readJson<GeneratedMeta>(join(dir, "meta.json"));
      if (!meta) continue;
      const raw = readJson<unknown>(join(dir, "jury.json"));
      const verdict = isVerdict(raw) ? raw : null;
      let violations: string[] = [];
      try {
        const html = readFileSync(join(dir, "index.html"), "utf8");
        violations = [...validateSelfContained(html), ...validateVendorPlaceholders(html, declared)];
      } catch {
        // no index.html — leave violations empty
      }
      const refinementsMd = existsSync(join(dir, "refinements.md")) ? readFileSync(join(dir, "refinements.md"), "utf8") : "";
      // In rejected/, a note, a refinement log or an orphan record means the work
      // sat in pending/ at some point (refine and re-jury always land there), so
      // the artist ruled on it whatever its verdict says. Otherwise a passing,
      // self-contained verdict is the only way into pending/. (Violations are
      // re-checked against today's config — a library declared since can blur it.)
      const visitedPending = ["rejection.md", "refinements.md", "orphan.json"].some((f) => existsSync(join(dir, f)));
      const decidedBy: WorkRecord["decidedBy"] =
        status === "published"
          ? "artist"
          : status === "rejected"
            ? visitedPending || (verdict && verdict.verdict !== "reject" && violations.length === 0)
              ? "artist"
              : "machine"
            : "open";
      works.push({
        id: e.name,
        status,
        title: typeof meta.title === "string" && meta.title ? meta.title : e.name,
        verdict,
        decidedBy,
        violations,
        rejectionNote: existsSync(join(dir, "rejection.md")),
        refinements: (refinementsMd.match(/^## Refinement /gm) ?? []).length,
      });
    }
  }
  return works.sort((a, b) => b.id.localeCompare(a.id));
}

export function lifecycleCounts(works: WorkRecord[]): Record<WorkStatus, number> {
  const out: Record<WorkStatus, number> = { pending: 0, published: 0, rejected: 0, orphaned: 0 };
  for (const w of works) out[w.status]++;
  return out;
}

const passes = (v: Verdict): boolean => v !== "reject";

/** The individual opinions behind a verdict: the panel, or the verdict itself. */
export function opinionsOf(v: JuryVerdict): JurorOpinion[] {
  return v.panel && v.panel.length > 0 ? v.panel : [v];
}

export interface JurorStat {
  model: string;
  graded: number;
  verdicts: Record<Verdict, number>;
  /** Mean weighted_total / max_weighted, 0–1. */
  meanShare: number;
  /** Gate id → times this juror failed it. */
  gateFails: Record<string, number>;
  /** Opinions given as one of ≥ 2 jurors. */
  panelSittings: number;
  /** Panel sittings where its pass/fail differed from the panel's. */
  dissents: number;
  /** Opinions on works the artist ruled on at the gate. */
  artistRuled: number;
  /** …of which its pass/fail matched the artist's approve/reject. */
  artistAgreed: number;
  firstId: string;
  lastId: string;
}

export function jurorStats(works: WorkRecord[]): JurorStat[] {
  const stats = new Map<string, JurorStat & { shareSum: number }>();
  for (const w of [...works].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!w.verdict) continue;
    const ops = opinionsOf(w.verdict);
    const panel = ops.length > 1;
    for (const o of ops) {
      const model = o.jury_model;
      let s = stats.get(model);
      if (!s) {
        s = {
          model,
          graded: 0,
          verdicts: { strong: 0, borderline: 0, reject: 0 },
          meanShare: 0,
          shareSum: 0,
          gateFails: {},
          panelSittings: 0,
          dissents: 0,
          artistRuled: 0,
          artistAgreed: 0,
          firstId: w.id,
          lastId: w.id,
        };
        stats.set(model, s);
      }
      s.graded++;
      s.verdicts[o.verdict] = (s.verdicts[o.verdict] ?? 0) + 1;
      if (o.max_weighted > 0) s.shareSum += o.weighted_total / o.max_weighted;
      for (const [g, ok] of Object.entries(o.gates ?? {})) if (ok === false) s.gateFails[g] = (s.gateFails[g] ?? 0) + 1;
      if (panel) {
        s.panelSittings++;
        if (passes(o.verdict) !== passes(w.verdict.verdict)) s.dissents++;
      }
      if (w.decidedBy === "artist") {
        s.artistRuled++;
        if (passes(o.verdict) === (w.status === "published")) s.artistAgreed++;
      }
      s.lastId = w.id;
    }
  }
  return [...stats.values()]
    .map(({ shareSum, ...s }) => ({ ...s, meanShare: s.graded ? shareSum / s.graded : 0 }))
    .sort((a, b) => b.graded - a.graded);
}

export interface RubricPractice {
  /** Final verdicts considered (one per juried work). */
  verdicts: number;
  /** Individual opinions considered (panel members counted separately). */
  opinions: number;
  /** Gate id → opinions that failed it. */
  gateFails: Record<string, number>;
  /** Dimension → mean score across opinions. */
  scoreMeans: Record<string, number>;
  outcome: Record<Verdict, number>;
}

/** How the DNA's rubric is landing in practice, across every juried work. */
export function rubricInPractice(works: WorkRecord[], rubric: Rubric): RubricPractice {
  const gateFails: Record<string, number> = Object.fromEntries(rubric.gates.map((g) => [g, 0]));
  const sums: Record<string, number> = Object.fromEntries(Object.keys(rubric.weights).map((d) => [d, 0]));
  const counts: Record<string, number> = Object.fromEntries(Object.keys(rubric.weights).map((d) => [d, 0]));
  const outcome: Record<Verdict, number> = { strong: 0, borderline: 0, reject: 0 };
  let verdicts = 0;
  let opinions = 0;
  for (const w of works) {
    if (!w.verdict) continue;
    verdicts++;
    outcome[w.verdict.verdict]++;
    for (const o of opinionsOf(w.verdict)) {
      opinions++;
      for (const g of rubric.gates) if (o.gates?.[g] === false) gateFails[g] = (gateFails[g] ?? 0) + 1;
      for (const d of Object.keys(rubric.weights)) {
        const v = o.scores?.[d];
        if (typeof v === "number") {
          sums[d]! += v;
          counts[d]!++;
        }
      }
    }
  }
  const scoreMeans = Object.fromEntries(
    Object.keys(rubric.weights).map((d) => [d, counts[d] ? sums[d]! / counts[d]! : 0]),
  );
  return { verdicts, opinions, gateFails, scoreMeans, outcome };
}

// ── The daemon log ───────────────────────────────────────────────────────────

export interface DaemonEvent {
  at: string;
  kind:
    | "up"
    | "wake-start"
    | "wake-done"
    | "wake-error"
    | "wake-skipped"
    | "petition"
    | "amend-check"
    | "notified"
    | "other";
  text: string;
}

/**
 * Parse `[daemon] <ISO> <message>` lines (other lines are ignored). Pass both
 * logs: the daemon writes wake errors with console.error, which launchd routes
 * to daemon.err.log. Events come back in time order.
 */
export function parseDaemonLog(...texts: string[]): DaemonEvent[] {
  const out: DaemonEvent[] = [];
  for (const line of texts.join("\n").split("\n")) {
    const m = line.match(/^\[daemon\] (\d{4}-\d{2}-\d{2}T\S+) (.*)$/);
    if (!m) continue;
    const msg = m[2]!;
    const kind: DaemonEvent["kind"] = / up\. interval=/.test(msg)
      ? "up"
      : msg.startsWith("wake start")
        ? "wake-start"
        : msg.startsWith("wake done")
          ? "wake-done"
          : msg.startsWith("wake error")
            ? "wake-error"
            : msg.startsWith("wake skipped")
              ? "wake-skipped"
              : msg.startsWith("amendment petition filed")
                ? "petition"
                : msg.startsWith("amendment check")
                  ? "amend-check"
                  : msg.startsWith("notified")
                  ? "notified"
                  : "other";
    out.push({ at: m[1]!, kind, text: msg });
  }
  return out
    .map((e, i) => ({ e, i, t: new Date(e.at).getTime() }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * A human line for a wake event: "wake done in 813s: {…json…}" becomes
 * "passed after 2 attempts · $1.62 · 14 min"; errors keep their message.
 */
export function summarizeWake(e: DaemonEvent): string {
  if (e.kind === "wake-error") return e.text.replace(/^wake error:\s*/, "failed — ");
  const m = e.text.match(/^wake done in (\d+)s: (\{.*\})\s*$/);
  if (!m) return e.text;
  try {
    const r = JSON.parse(m[2]!) as { passed?: boolean; attempts?: number; stopReason?: string; spentUsd?: number; detail?: string };
    const secs = Number(m[1]);
    const took = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs} s`;
    const attempts = `${r.attempts ?? 0} attempt${r.attempts === 1 ? "" : "s"}`;
    const head = r.passed
      ? `passed after ${attempts}`
      : `no pass — stopped by ${r.stopReason === "time-budget" ? "the time budget" : r.stopReason === "fuse" ? `the $ fuse${r.detail ? ` (${r.detail})` : ""}` : (r.stopReason ?? "?")} after ${attempts}`;
    return `${head} · $${(r.spentUsd ?? 0).toFixed(2)} · ${took}`;
  } catch {
    return e.text;
  }
}

/** The tail of a possibly large log file (last `bytes`), from a line boundary. */
export function readTail(path: string, bytes = 256 * 1024): string {
  if (!existsSync(path)) return "";
  const buf = readFileSync(path);
  if (buf.length <= bytes) return buf.toString("utf8");
  const s = buf.subarray(buf.length - bytes).toString("utf8");
  return s.slice(s.indexOf("\n") + 1);
}

export interface WakeSchedule {
  /** A wake started and hasn't logged its end yet. */
  inProgress: boolean;
  lastWake: DaemonEvent | null;
  /** Best estimate of the next wake, ISO; null when unknowable. */
  next: string | null;
  /** The interval the running daemon was started with (its "up." line), else the config's. */
  intervalHours: number;
  /** True when intervalHours came from the daemon's own start-up line. */
  intervalFromLog: boolean;
}

/**
 * The daemon schedules the next wake `interval` after the previous one ends
 * (or after start-up when it doesn't wake on start), so the latest of those
 * moments plus the interval is the next wake.
 */
export function wakeSchedule(events: DaemonEvent[], configIntervalHours: number): WakeSchedule {
  // The daemon reads its config once, at start-up: its "up." line is the truth.
  const up = [...events].reverse().find((e) => e.kind === "up");
  const logged = Number(up?.text.match(/ interval=(\d+(?:\.\d+)?)h/)?.[1]);
  const intervalFromLog = Number.isFinite(logged) && logged > 0;
  const intervalHours = intervalFromLog ? logged : configIntervalHours;
  // The next timer starts once a wake AND its amendment check have finished.
  const marks = events.filter((e) =>
    ["up", "wake-start", "wake-done", "wake-error", "petition", "amend-check"].includes(e.kind),
  );
  const last = marks.at(-1) ?? null;
  const lastWake = [...events].reverse().find((e) => e.kind === "wake-done" || e.kind === "wake-error") ?? null;
  const base = { lastWake, intervalHours, intervalFromLog };
  if (!last) return { ...base, inProgress: false, next: null };
  if (last.kind === "wake-start") return { ...base, inProgress: true, next: null };
  return {
    ...base,
    inProgress: false,
    next: new Date(new Date(last.at).getTime() + intervalHours * 3_600_000).toISOString(),
  };
}
