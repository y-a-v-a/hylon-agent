import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectWorks,
  jurorStats,
  lifecycleCounts,
  parseDaemonLog,
  rubricInPractice,
  summarizeWake,
  wakeSchedule,
  type WorkRecord,
} from "./insights.ts";
import type { Config } from "./config.ts";
import type { JurorOpinion, JuryVerdict, Verdict } from "./jury.ts";

const GATES = ["G1", "G2"];
const rubric = { gates: GATES, weights: { novelty: 3, craft: 1 }, scoreMax: 5 };

function opinion(model: string, verdict: Verdict, total: number, failGate?: string): JurorOpinion {
  return {
    work_id: "w",
    gates: { G1: failGate !== "G1", G2: failGate !== "G2" },
    scores: { novelty: Math.round(total / 4), craft: 4 },
    weighted_total: total,
    max_weighted: 20,
    verdict,
    references_named: [],
    principles_invoked: [],
    rationale: "r",
    reservations: null,
    revision_suggestion: null,
    jury_model: model,
  };
}

function verdict(final: Verdict, total: number, panel?: JurorOpinion[]): JuryVerdict {
  const base = opinion(panel ? panel.map((p) => p.jury_model).join(" + ") : "m/solo", final, total);
  return panel ? { ...base, panel, unanimous: panel.every((p) => p.verdict === final) } : base;
}

function fixture(): { root: string; cfg: Config } {
  const root = mkdtempSync(join(tmpdir(), "agent-insights-"));
  const cfg = {
    abs: {
      root,
      pending: join(root, "pending"),
      published: join(root, "published"),
      rejected: join(root, "rejected"),
      orphaned: join(root, "orphaned"),
    },
    technologies: { apis: [], libraries: {} },
  } as unknown as Config;
  const put = (status: string, id: string, v: JuryVerdict | null, html = "<!doctype html><p>ok</p>", extra: Record<string, string> = {}): void => {
    const dir = join(root, status, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ title: id.slice(11) }));
    writeFileSync(join(dir, "index.html"), html);
    if (v) writeFileSync(join(dir, "jury.json"), JSON.stringify(v));
    for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c);
  };
  const A = "a/judge";
  const B = "b/judge";
  const C = "c/judge";
  // approved by the artist; B dissented (reject vs the panel's strong)
  put("published", "2026-10-01-approved", verdict("strong", 18, [opinion(A, "strong", 18), opinion(B, "reject", 10, "G2"), opinion(C, "strong", 17)]));
  // jury passed it, the artist rejected it (with a note)
  put("rejected", "2026-10-02-artist-no", verdict("borderline", 14, [opinion(A, "borderline", 14), opinion(B, "reject", 9, "G1"), opinion(C, "borderline", 13)]), undefined, {
    "rejection.md": "# Rejection note\n\nno",
  });
  // the jury rejected it — never reached the artist
  put("rejected", "2026-10-03-jury-no", verdict("reject", 8, [opinion(A, "reject", 8, "G1"), opinion(B, "reject", 7, "G1"), opinion(C, "borderline", 12)]));
  // passing verdict, but not self-contained → the harness routed it, not the artist
  put("rejected", "2026-10-04-leaky", verdict("strong", 18), "<script>fetch('https://x.test')</script>");
  put("pending", "2026-10-05-waiting", verdict("strong", 19), undefined, {
    "refinements.md": "\n## Refinement 2026-10-05T10:00:00.000Z\n\n**Feedback:** more\n\n## Refinement 2026-10-05T11:00:00.000Z\n\n**Feedback:** less\n",
  });
  put("orphaned", "2026-10-06-stranded", null);
  // refined (re-jury said reject, refine keeps it pending), then rejected by the artist
  put("rejected", "2026-10-07-refined-then-no", verdict("reject", 9), undefined, {
    "refinements.md": "\n## Refinement 2026-10-07T10:00:00.000Z\n\n**Feedback:** try again\n",
  });
  // re-juried orphan (always lands in pending), then rejected by the artist
  put("rejected", "2026-10-08-rejuried-then-no", verdict("reject", 9), undefined, { "orphan.json": "{}" });
  // malformed jury.json → treated as no verdict, never a crash
  put("rejected", "2026-10-09-garbled", { nonsense: true } as unknown as JuryVerdict);
  mkdirSync(join(root, "pending", "not-a-work"), { recursive: true }); // no meta.json → skipped
  return { root, cfg };
}

test("collectWorks classifies who settled each work's fate", () => {
  const { root, cfg } = fixture();
  try {
    const works = collectWorks(cfg);
    const by = Object.fromEntries(works.map((w) => [w.id.slice(11), w]));
    assert.equal(works.length, 9);
    assert.equal(works[0]!.id, "2026-10-09-garbled", "newest first");
    assert.equal(by["refined-then-no"]!.decidedBy, "artist", "refined works sat in pending");
    assert.equal(by["rejuried-then-no"]!.decidedBy, "artist", "re-juried works sat in pending");
    assert.equal(by.garbled!.verdict, null);
    assert.equal(by.approved!.decidedBy, "artist");
    assert.equal(by["artist-no"]!.decidedBy, "artist");
    assert.equal(by["artist-no"]!.rejectionNote, true);
    assert.equal(by["jury-no"]!.decidedBy, "machine");
    assert.equal(by.leaky!.decidedBy, "machine");
    assert.match(by.leaky!.violations.join(), /fetch/);
    assert.equal(by.waiting!.decidedBy, "open");
    assert.equal(by.waiting!.refinements, 2);
    assert.equal(by.stranded!.verdict, null);
    assert.deepEqual(lifecycleCounts(works), { pending: 1, published: 1, rejected: 6, orphaned: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jurorStats: dissents against the panel, agreement with the artist", () => {
  const { root, cfg } = fixture();
  try {
    const stats = Object.fromEntries(jurorStats(collectWorks(cfg)).map((s) => [s.model, s]));
    const a = stats["a/judge"]!;
    const b = stats["b/judge"]!;
    const c = stats["c/judge"]!;
    assert.equal(a.graded, 3);
    assert.equal(a.panelSittings, 3);
    assert.equal(a.dissents, 0);
    // the artist ruled on "approved" (yes) and "artist-no" (no); A passed both
    assert.equal(a.artistRuled, 2);
    assert.equal(a.artistAgreed, 1);
    // B rejected both: wrong on the approval, right on the artist's rejection
    assert.equal(b.dissents, 2);
    assert.equal(b.artistAgreed, 1);
    assert.deepEqual(b.gateFails, { G2: 1, G1: 2 });
    // C passed the work the panel rejected
    assert.equal(c.dissents, 1);
    assert.equal(stats["m/solo"]!.panelSittings, 0, "solo verdicts are not panel sittings");
    assert.equal(a.firstId, "2026-10-01-approved");
    assert.equal(a.lastId, "2026-10-03-jury-no");
    assert.ok(Math.abs(a.meanShare - (18 + 14 + 8) / 60) < 1e-9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rubricInPractice counts gate failures and mean scores across opinions", () => {
  const { root, cfg } = fixture();
  try {
    const p = rubricInPractice(collectWorks(cfg).filter((w) => w.id < "2026-10-07"), rubric);
    assert.equal(p.verdicts, 5);
    assert.equal(p.opinions, 11);
    assert.equal(p.gateFails.G1, 3);
    assert.equal(p.gateFails.G2, 1);
    assert.equal(p.scoreMeans.craft, 4);
    assert.deepEqual(p.outcome, { strong: 3, borderline: 1, reject: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rubricInPractice of nothing is all zeros", () => {
  const p = rubricInPractice([] as WorkRecord[], rubric);
  assert.equal(p.verdicts, 0);
  assert.deepEqual(p.gateFails, { G1: 0, G2: 0 });
  assert.deepEqual(p.scoreMeans, { novelty: 0, craft: 0 });
});

const LOG = `[daemon] 2026-10-20T18:00:00.000Z my agent up. interval=24h work-budget=20min fuse=$5/wake $20/day generator=a jury=b
[dashboard] http://localhost:4737
[daemon] 2026-10-20T18:00:00.001Z first wake in 24h
[daemon] 2026-10-21T18:00:00.000Z wake start
[daemon] 2026-10-21T18:13:20.000Z wake done in 800s: {"passed":true,"attempts":2,"stopReason":"passed","publishedId":"x","spentUsd":1.5}
[daemon] 2026-10-21T18:13:21.000Z amendment petition filed: 2026-10-21-amendment
`;

test("parseDaemonLog + wakeSchedule: next wake is an interval after the last wake ended", () => {
  const events = parseDaemonLog(LOG);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["up", "other", "wake-start", "wake-done", "petition"],
  );
  const s = wakeSchedule(events, 24);
  assert.equal(s.inProgress, false);
  assert.equal(s.lastWake?.kind, "wake-done");
  assert.equal(s.next, "2026-10-22T18:13:21.000Z", "scheduled after the post-wake petition, like daemon.ts");

  const running = wakeSchedule(parseDaemonLog(LOG + "[daemon] 2026-10-22T18:13:20.000Z wake start\n"), 24);
  assert.equal(running.inProgress, true);
  assert.equal(running.next, null);

  const restarted = wakeSchedule(parseDaemonLog(LOG + "[daemon] 2026-10-22T09:00:00.000Z hylon up. interval=12h\n"), 12);
  assert.equal(restarted.next, "2026-10-22T21:00:00.000Z", "a restart resets the schedule");
  assert.equal(wakeSchedule([], 24).next, null);
});

test("wake errors are logged to stderr: merge both logs, in time order", () => {
  const out = "[daemon] 2026-10-21T18:00:00.000Z wake start\n";
  const err = "[daemon] 2026-10-21T18:00:03.000Z wake error: Wake attempt 1 failed: Model not found\nsome stack line\n";
  const events = parseDaemonLog(out, err);
  assert.deepEqual(events.map((e) => e.kind), ["wake-start", "wake-error"]);
  const s = wakeSchedule(events, 24);
  assert.equal(s.inProgress, false, "an errored wake is over");
  assert.equal(s.lastWake?.kind, "wake-error");
  assert.equal(s.next, "2026-10-22T18:00:03.000Z");
});

test("wakeSchedule uses the daemon's own interval and waits for the amendment check", () => {
  const log = `[daemon] 2026-10-20T00:00:00.000Z hylon up. interval=24h work-budget=20min
[daemon] 2026-10-21T00:00:00.000Z wake start
[daemon] 2026-10-21T00:10:00.000Z wake done in 600s: {"passed":true,"attempts":1,"spentUsd":1}
[daemon] 2026-10-21T00:12:00.000Z amendment check: no-change (NO AMENDMENT)
`;
  const s = wakeSchedule(parseDaemonLog(log), 6); // config edited to 6 h since start-up
  assert.equal(s.intervalHours, 24);
  assert.equal(s.intervalFromLog, true);
  assert.equal(s.next, "2026-10-22T00:12:00.000Z");
  assert.equal(wakeSchedule(parseDaemonLog("[daemon] 2026-10-21T00:00:00.000Z wake start\n"), 6).intervalFromLog, false);
});

test("summarizeWake turns the logged result into a sentence", () => {
  const [done] = parseDaemonLog(LOG).filter((e) => e.kind === "wake-done");
  assert.equal(summarizeWake(done!), "passed after 2 attempts · $1.50 · 13 min");
  const fuse = parseDaemonLog(
    '[daemon] 2026-10-21T18:00:00.000Z wake done in 12s: {"passed":false,"attempts":1,"stopReason":"fuse","detail":"daily cap $20 reached ($20.100)","spentUsd":0.4}\n',
  )[0]!;
  assert.equal(summarizeWake(fuse), "no pass — stopped by the $ fuse (daily cap $20 reached ($20.100)) after 1 attempt · $0.40 · 12 s");
  const err = parseDaemonLog("[daemon] 2026-10-21T18:00:00.000Z wake error: boom\n")[0]!;
  assert.equal(summarizeWake(err), "failed — boom");
});
