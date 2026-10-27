import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  parseFormBody,
  renderIndex,
  renderCandidate,
  renderResolved,
  renderNotFound,
  renderOrphan,
  renderAmendment,
  renderDnaDiff,
  type PendingItem,
} from "./dashboard.ts";
import type { OrphanItem } from "./orphans.ts";
import type { AmendmentItem } from "./amend.ts";
import { statusFor } from "./promote.ts";
import type { GeneratedMeta } from "./generator.ts";
import type { JuryVerdict } from "./jury.ts";

const meta: GeneratedMeta = {
  title: "The <Original>",
  summary: "A & B summary",
  mechanism: "blob download",
  principles: ["P1"],
  references: ["Benjamin"],
  license: "CC BY-SA 4.0",
};

const verdict: JuryVerdict = {
  work_id: "x",
  gates: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true },
  scores: { novelty: 4, nuance: 4, narrative: 4, craft: 4, wit: 4 },
  weighted_total: 40,
  max_weighted: 50,
  verdict: "strong",
  references_named: ["Benjamin"],
  principles_invoked: ["P1", "P6"],
  rationale: "Rationale text",
  reservations: null,
  revision_suggestion: null,
  jury_model: "minimax/minimax-m3",
};

test("escapeHtml neutralizes angle brackets, amp, quote", () => {
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("renderIndex shows empty-state when nothing pending", () => {
  assert.match(renderIndex([]), /No candidates awaiting confirmation/);
});

test("renderIndex lists items with verdict badge and escapes titles", () => {
  const items: PendingItem[] = [{ id: "2026-06-16-x", meta, verdict }];
  const html = renderIndex(items);
  assert.match(html, /Pending \(1\)/);
  assert.match(html, /strong 40\/50/);
  assert.match(html, /The &lt;Original&gt;/); // escaped
  assert.doesNotMatch(html, /The <Original>/);
});

test("renderIndex uses the agent name in the header", () => {
  const html = renderIndex([], [], "hylon");
  assert.match(html, /<a href="\/">hylon<\/a> · approval gateway/);
});

test("renderCandidate embeds work iframe, scores, rationale, and action forms", () => {
  const html = renderCandidate("2026-06-16-x", meta, verdict, "motivation body");
  assert.match(html, /\/candidate\/2026-06-16-x\/work/);
  assert.match(html, /novelty 4 · nuance 4/);
  assert.match(html, /Rationale text/);
  assert.match(html, /action="\/candidate\/2026-06-16-x\/approve"/);
  assert.match(html, /action="\/candidate\/2026-06-16-x\/reject"/);
  assert.match(html, /motivation body/);
});

test("renderResolved shows published status, work, and no action forms", () => {
  const html = renderResolved("2026-06-16-x", meta, verdict, "published", "motivation body");
  assert.match(html, /Published ✓/);
  assert.match(html, /\/candidate\/2026-06-16-x\/work/); // work still viewable
  assert.match(html, /back to pending/);
  assert.doesNotMatch(html, /action="[^"]*\/approve"/); // no approve/reject buttons
});

test("renderResolved shows rejected status", () => {
  assert.match(renderResolved("id", meta, verdict, "rejected", ""), /Rejected/);
});

test("renderCandidate shows the refine textarea + actions when not refining", () => {
  const html = renderCandidate("2026-06-16-x", meta, verdict, "m");
  assert.match(html, /name="feedback"/);
  assert.match(html, /\/candidate\/2026-06-16-x\/refine/);
  assert.match(html, /Approve/);
});

test("renderCandidate shows 'Refining…' and hides actions while refining", () => {
  const html = renderCandidate("2026-06-16-x", meta, verdict, "m", true);
  assert.match(html, /Refining…/);
  assert.doesNotMatch(html, /name="feedback"/);
  assert.doesNotMatch(html, /\/approve"/);
});

test("renderCandidate reject form has an optional learning note textarea", () => {
  const html = renderCandidate("2026-06-16-x", meta, verdict, "m");
  assert.match(html, /name="note"/);
  assert.match(html, /learns from it next round/);
});

test("parseFormBody decodes urlencoded fields (+ and %)", () => {
  assert.deepEqual(parseFormBody("feedback=fix+the+TypeError%20now&x=1"), {
    feedback: "fix the TypeError now",
    x: "1",
  });
});

test("parseFormBody returns {} for an empty body", () => {
  assert.deepEqual(parseFormBody(""), {});
});

test("renderNotFound links back to the landing page", () => {
  const html = renderNotFound();
  assert.match(html, /Nothing here/);
  assert.match(html, /href="\/"/);
});

test("statusFor maps approve→published / reject→rejected", () => {
  assert.deepEqual(statusFor("approve"), { status: "published", verb: "publish" });
  assert.deepEqual(statusFor("reject"), { status: "rejected", verb: "reject" });
});

// ── orphans ──────────────────────────────────────────────────────────────────

const orphan: OrphanItem = {
  id: "2026-07-27-stranded",
  meta,
  orphan: {
    id: "2026-07-27-stranded",
    at: "2026-07-27T12:00:00.000Z",
    error: "OpenRouter returned no content",
    violations: [],
    costUsd: 1.234,
  },
};

test("renderIndex omits the orphan section when there are none", () => {
  assert.doesNotMatch(renderIndex([]), /Orphaned/);
});

test("renderIndex lists orphans with their stranding error, below pending", () => {
  const html = renderIndex([{ id: "2026-06-16-x", meta, verdict }], [orphan]);
  assert.match(html, /Pending \(1\)/);
  assert.match(html, /Orphaned \(1\)/);
  assert.match(html, /OpenRouter returned no content/);
  assert.match(html, /href="\/orphan\/2026-07-27-stranded"/);
  assert.match(html, /The &lt;Original&gt;/); // still escaped
});

test("renderIndex shows orphans even when nothing is pending", () => {
  const html = renderIndex([], [orphan]);
  assert.match(html, /No candidates awaiting confirmation/);
  assert.match(html, /Orphaned \(1\)/);
});

test("renderOrphan shows the work, the failure, and a re-jury form — no approve/reject", () => {
  const html = renderOrphan(orphan.id, meta, orphan.orphan, "motivation body");
  assert.match(html, /\/orphan\/2026-07-27-stranded\/work/);
  assert.match(html, /action="\/orphan\/2026-07-27-stranded\/rejury"/);
  assert.match(html, /OpenRouter returned no content/);
  assert.match(html, /\$1\.23/); // generation cost already spent
  assert.match(html, /motivation body/);
  assert.doesNotMatch(html, /\/approve"/);
  assert.doesNotMatch(html, /name="feedback"/);
});

test("renderOrphan surfaces self-containment violations when present", () => {
  const html = renderOrphan(orphan.id, meta, { ...orphan.orphan!, violations: ["external src: https://x"] }, "");
  assert.match(html, /self-containment violations/);
  assert.match(html, /external src: https:\/\/x/);
});

test("renderOrphan tolerates a missing orphan record", () => {
  const html = renderOrphan(orphan.id, meta, null, "");
  assert.match(html, /stranded \(no record\)/);
  assert.match(html, /action="\/orphan\/2026-07-27-stranded\/rejury"/);
});

// ── jury panels ──────────────────────────────────────────────────────────────

test("renderCandidate shows per-juror opinions for a panel verdict", () => {
  const panelVerdict: JuryVerdict = {
    ...verdict,
    rationale: "Panel of 2 — 1 strong · 1 reject. Each juror's independent opinion is recorded.",
    jury_model: "minimax/minimax-m3 + openai/gpt-4o",
    unanimous: false,
    panel: [
      { ...verdict, jury_model: "minimax/minimax-m3", rationale: "JUROR_ONE_SAYS strong work" },
      {
        ...verdict,
        jury_model: "openai/gpt-4o",
        verdict: "reject",
        weighted_total: 25,
        rationale: "JUROR_TWO_SAYS derivative",
        reservations: "the voice slips",
      },
    ],
  };
  const html = renderCandidate("2026-06-16-x", meta, panelVerdict, "m");
  assert.match(html, /Panel opinions \(split\)/);
  assert.match(html, /JUROR_ONE_SAYS/);
  assert.match(html, /JUROR_TWO_SAYS/);
  assert.match(html, /reject 25\/50/);
  assert.match(html, /the voice slips/);
});

test("renderCandidate shows no panel section for a single-juror verdict", () => {
  assert.doesNotMatch(renderCandidate("2026-06-16-x", meta, verdict, "m"), /Panel opinions/);
});

// ── DNA amendment petitions ──────────────────────────────────────────────────

const amendment: AmendmentItem = {
  id: "2026-07-29-amendment",
  record: {
    id: "2026-07-29-amendment",
    at: "2026-07-29T10:00:00.000Z",
    model: "anthropic/claude-sonnet-4.5",
    signalsThrough: "2026-07-29T10:00:00.000Z",
    signalCount: 6,
    published: 2,
    rejected: 4,
    warnings: ["gate G2 no longer mentioned"],
    diff: { added: 4, removed: 2 },
    costUsd: 0.021,
    status: "pending",
  },
  rationale: "The artist consistently rejects <reverent> homage; the DNA should name the required bite.",
  proposedDna: "# DNA\nline kept\nline changed NEW",
};

test("renderIndex omits the amendment section when there is none", () => {
  assert.doesNotMatch(renderIndex([]), /Amendment/);
});

test("renderIndex lists a pending petition with its diff stat", () => {
  const html = renderIndex([], [], "hylon", [amendment]);
  assert.match(html, /DNA amendment \(1\)/);
  assert.match(html, /href="\/amendment\/2026-07-29-amendment"/);
  assert.match(html, /\+4 −2/);
  assert.match(html, /Nothing changes without your approval/);
});

test("renderDnaDiff colorizes added and removed lines and escapes content", () => {
  const html = renderDnaDiff("a\n<b>\nc", "a\n<b> changed\nc", 0);
  assert.match(html, /class="del">− &lt;b&gt;</);
  assert.match(html, /class="add">\+ &lt;b&gt; changed</);
  assert.doesNotMatch(html, /<b>/);
});

test("renderAmendment shows rationale, warnings, diff, and ratify/decline forms", () => {
  const html = renderAmendment(amendment, "# DNA\nline kept\nline changed OLD", "hylon");
  assert.match(html, /rejects &lt;reverent&gt; homage/); // escaped rationale
  assert.match(html, /gate G2 no longer mentioned/);
  assert.match(html, /class="del"/);
  assert.match(html, /class="add"/);
  assert.match(html, /action="\/amendment\/2026-07-29-amendment\/approve"/);
  assert.match(html, /action="\/amendment\/2026-07-29-amendment\/reject"/);
  assert.match(html, /name="note"/);
  assert.match(html, /6 signals/);
});
