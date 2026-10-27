import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle, setRefiner, setDecider, setRejurier, setAmendDecider } from "./dashboard.ts";
import { isRefining, runRefine } from "./refine.ts";
import { decide } from "./promote.ts";
import { rejuryOrphan, writeOrphanRecord } from "./orphans.ts";
import { decideAmendment } from "./amend.ts";
import type { Config } from "./config.ts";

// Drives the real request handler against a temp fixture with no socket and no
// real workspace — fully hermetic, so it runs free in CI. This codifies the
// route/CSP/sandbox/traversal checks that were previously done by hand with curl.

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(code: number, headers?: Record<string, string>): MockRes;
  end(chunk?: string): void;
}

function mockRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

function fixtureConfig(root: string): Config {
  return {
    abs: {
      root,
      pending: join(root, "pending"),
      published: join(root, "published"),
      rejected: join(root, "rejected"),
      orphaned: join(root, "orphaned"),
      dna: join(root, "DNA.md"),
      catalogue: join(root, "catalogue.json"),
      amendments: join(root, "amendments"),
    },
  } as unknown as Config;
}

async function request(cfg: Config, url: string): Promise<MockRes> {
  const res = mockRes();
  const req = { method: "GET", url } as unknown as IncomingMessage;
  await handle(req, res as unknown as ServerResponse, cfg);
  return res;
}

function postReq(url: string, body: string): IncomingMessage {
  async function* gen(): AsyncGenerator<string> {
    yield body;
  }
  const it = gen();
  return { method: "POST", url, [Symbol.asyncIterator]: () => it } as unknown as IncomingMessage;
}

test("dashboard handler: routes, CSP, sandbox, traversal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-dash-it-"));
  try {
    const id = "2026-06-16-fixture-work";
    const dir = join(root, "pending", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><h1>FIXTURE_WORK</h1>");
    writeFileSync(join(dir, "motivation.md"), "the motivation");
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        title: "Fixture Work",
        summary: "a fixture",
        mechanism: "m",
        principles: ["P1"],
        references: ["R"],
        license: "CC BY-SA 4.0",
      }),
    );
    writeFileSync(
      join(dir, "jury.json"),
      JSON.stringify({
        work_id: id,
        gates: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true },
        scores: { novelty: 4, nuance: 4, narrative: 4, craft: 4, wit: 4 },
        weighted_total: 40,
        max_weighted: 50,
        verdict: "strong",
        references_named: ["R"],
        principles_invoked: ["P1"],
        rationale: "ok",
        reservations: null,
        revision_suggestion: null,
        jury_model: "test",
      }),
    );
    const cfg = fixtureConfig(root);

    await t.test("GET / lists the pending candidate", async () => {
      const r = await request(cfg, "/");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /Pending \(1\)/);
      assert.match(r.body, /Fixture Work/);
    });

    await t.test("GET /candidate/:id renders a sandboxed iframe", async () => {
      const r = await request(cfg, `/candidate/${id}`);
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /sandbox="allow-scripts allow-downloads"/);
      assert.match(r.body, /the motivation/);
    });

    await t.test("GET /candidate/:id/work serves the work with the CSP header", async () => {
      const r = await request(cfg, `/candidate/${id}/work`);
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /FIXTURE_WORK/);
      assert.match(r.headers["Content-Security-Policy"] ?? "", /connect-src 'none'/);
      assert.match(r.headers["Content-Security-Policy"] ?? "", /default-src 'none'/);
    });

    await t.test("traversal id → 404 (not a file read)", async () => {
      const r = await request(cfg, `/candidate/${encodeURIComponent("../../etc/passwd")}/work`);
      assert.equal(r.statusCode, 404);
      assert.doesNotMatch(r.body, /root:.*:0:0/);
    });

    await t.test("unknown id → 303 redirect to landing", async () => {
      const r = await request(cfg, "/candidate/2026-01-01-does-not-exist");
      assert.equal(r.statusCode, 303);
      assert.equal(r.headers["Location"], "/");
    });

    await t.test("POST refine marks refining, 303s back, and invokes the refiner", async () => {
      const calls: { id: string; feedback: string }[] = [];
      setRefiner(async (rid, fb) => {
        calls.push({ id: rid, feedback: fb });
      });
      try {
        const res = mockRes();
        await handle(
          postReq(`/candidate/${id}/refine`, "feedback=fix+the+TypeError"),
          res as unknown as ServerResponse,
          cfg,
        );
        assert.equal(res.statusCode, 303);
        assert.equal(res.headers["Location"], `/candidate/${id}`);
        assert.equal(calls.length, 1, "refiner invoked once");
        assert.equal(calls[0]!.id, id);
        assert.equal(calls[0]!.feedback, "fix the TypeError");
        assert.ok(isRefining(join(root, "pending", id)), "marker set");
      } finally {
        setRefiner(runRefine); // restore the real refiner for any later tests
      }
    });

    await t.test("POST reject with a note passes the note to the decider", async () => {
      const calls: { id: string; decision: string; note?: string }[] = [];
      setDecider(async (rid, decision, o) => {
        calls.push({ id: rid, decision, note: o?.note });
      });
      try {
        const res = mockRes();
        await handle(
          postReq(`/candidate/${id}/reject`, "note=too+reverent"),
          res as unknown as ServerResponse,
          cfg,
        );
        assert.equal(res.statusCode, 303);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.decision, "reject");
        assert.equal(calls[0]!.note, "too reverent");
      } finally {
        setDecider(decide); // restore the real decider
      }
    });

    // ── orphans: a finished work the jury never graded ──────────────────────
    const oid = "2026-07-27-stranded-fixture";
    const odir = join(root, "orphaned", oid);
    mkdirSync(odir, { recursive: true });
    writeFileSync(join(odir, "index.html"), "<!doctype html><h1>ORPHAN_WORK</h1>");
    writeFileSync(join(odir, "motivation.md"), "why it exists");
    writeFileSync(join(odir, "meta.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")), title: "Stranded Fixture" }));
    writeOrphanRecord(odir, {
      id: oid,
      at: "2026-07-27T12:00:00.000Z",
      error: "OpenRouter returned no content",
      violations: [],
      costUsd: 1.5,
    });

    await t.test("GET / lists the orphan under its own heading", async () => {
      const r = await request(cfg, "/");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /Orphaned \(1\)/);
      assert.match(r.body, /Stranded Fixture/);
      assert.match(r.body, /OpenRouter returned no content/);
    });

    await t.test("GET /orphan/:id renders the work and the re-jury form", async () => {
      const r = await request(cfg, `/orphan/${oid}`);
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /sandbox="allow-scripts allow-downloads"/);
      assert.match(r.body, /action="\/orphan\/2026-07-27-stranded-fixture\/rejury"/);
      assert.match(r.body, /why it exists/);
    });

    await t.test("GET /orphan/:id/work serves the work with the same CSP", async () => {
      const r = await request(cfg, `/orphan/${oid}/work`);
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /ORPHAN_WORK/);
      assert.match(r.headers["Content-Security-Policy"] ?? "", /connect-src 'none'/);
    });

    await t.test("orphan traversal id → 404 (not a file read)", async () => {
      const r = await request(cfg, `/orphan/${encodeURIComponent("../../etc/passwd")}/work`);
      assert.equal(r.statusCode, 404);
      assert.doesNotMatch(r.body, /root:.*:0:0/);
    });

    await t.test("GET /orphan/:id for an unknown id → 404", async () => {
      const r = await request(cfg, "/orphan/2026-01-01-does-not-exist");
      assert.equal(r.statusCode, 404);
    });

    // ── DNA amendment petition routes ───────────────────────────────────────
    const aid = "2026-07-29-amendment";
    const adir = join(root, "amendments", "pending", aid);
    mkdirSync(adir, { recursive: true });
    writeFileSync(join(root, "DNA.md"), "# DNA\nline kept\nline OLD\n");
    writeFileSync(join(adir, "proposal.md"), "AMEND_RATIONALE: the artist wants more bite.");
    writeFileSync(join(adir, "DNA.proposed.md"), "# DNA\nline kept\nline NEW\n");
    writeFileSync(
      join(adir, "amendment.json"),
      JSON.stringify({
        id: aid,
        at: "2026-07-29T10:00:00.000Z",
        model: "test/model",
        signalsThrough: "2026-07-29T10:00:00.000Z",
        signalCount: 6,
        published: 1,
        rejected: 3,
        warnings: [],
        diff: { added: 1, removed: 1 },
        costUsd: 0.02,
        status: "pending",
      }),
    );

    await t.test("GET / lists the pending petition", async () => {
      const r = await request(cfg, "/");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /DNA amendment \(1\)/);
      assert.match(r.body, /href="\/amendment\/2026-07-29-amendment"/);
    });

    await t.test("GET /amendment/:id renders rationale and diff against the current DNA", async () => {
      const r = await request(cfg, `/amendment/${aid}`);
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /AMEND_RATIONALE/);
      assert.match(r.body, /line OLD/);
      assert.match(r.body, /line NEW/);
      assert.match(r.body, /Ratify/);
    });

    await t.test("GET /amendment traversal id → 404; unknown id → 303", async () => {
      const bad = await request(cfg, `/amendment/${encodeURIComponent("../../etc/passwd")}`);
      assert.equal(bad.statusCode, 404);
      const unknown = await request(cfg, "/amendment/2026-01-01-amendment");
      assert.equal(unknown.statusCode, 303);
    });

    await t.test("POST /amendment reject passes the note to the amendment decider", async () => {
      const calls: { id: string; decision: string; note?: string }[] = [];
      setAmendDecider(async (rid, decision, o) => {
        calls.push({ id: rid, decision, note: o?.note });
      });
      try {
        const res = mockRes();
        await handle(
          postReq(`/amendment/${aid}/reject`, "note=keep+the+restraint"),
          res as unknown as ServerResponse,
          cfg,
        );
        assert.equal(res.statusCode, 303);
        assert.deepEqual(calls, [{ id: aid, decision: "reject", note: "keep the restraint" }]);
      } finally {
        setAmendDecider(decideAmendment);
      }
    });

    await t.test("POST rejury 303s to the landing page and invokes the re-jurier", async () => {
      const calls: string[] = [];
      setRejurier(async (rid) => {
        calls.push(rid);
      });
      try {
        const res = mockRes();
        await handle(postReq(`/orphan/${oid}/rejury`, ""), res as unknown as ServerResponse, cfg);
        assert.equal(res.statusCode, 303);
        assert.equal(res.headers["Location"], "/");
        assert.deepEqual(calls, [oid]);
      } finally {
        setRejurier(rejuryOrphan); // restore the real re-jurier
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
