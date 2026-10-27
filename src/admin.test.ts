import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { collectChecks, decodeEntities, gatherEnv, gatherOverview, guidanceEntries, handleAdmin, maskKey, type AdminDeps } from "./admin.ts";
import { defaultedKeys, rel, tok, usd } from "./adminview.ts";
import { parseConfig, type Config } from "./config.ts";
import type { Catalog, OpenRouterModel } from "./models.ts";

// Drives the admin console's request handler against a temp repo with every
// outside dependency stubbed (catalogue, key, git, process probes, clock) —
// hermetic, like dashboard.integration.test.ts.

const BASE = JSON.parse(readFileSync(new URL("../agent.config.json", import.meta.url), "utf8"));
const NOW = new Date("2026-10-26T12:00:00Z");

const DNA = `---
title: "Artistic DNA — Fixture <Artist>"
version: "0.3"
date: "2026-10-01"
---

# Artistic DNA — Fixture

## 1. One-line essence

Pages that wait <script>alert(1)</script>.

## 3. Principles

- **P1 — Attention.** Acts on attention.

## 8. Rubric

- **G1 A:** a? - **G2 B:** b? - **G3 C:** c?
- **G4 D:** d?
- **G5 E:** e?
- **G6 Not a duplicate:** new?
- **novelty (weight ×3):** n. **nuance (weight ×3):** n. **narrative (weight ×2):** n.
- **craft (weight ×1):** c. **wit (weight ×2):** w.
`;

function catalog(): Catalog {
  const m = (id: string, over: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
    id,
    name: id,
    context_length: 200_000,
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    top_provider: { max_completion_tokens: 64_000 },
    supported_parameters: ["tools", "response_format", "temperature", "max_tokens"],
    ...over,
  });
  return {
    models: [m("anthropic/claude-sonnet-4.5"), m("minimax/minimax-m3", { supported_parameters: ["temperature"] })],
    fetchedAt: "2026-10-26T11:59:00.000Z",
    source: "live",
  };
}

function fixture(): { root: string; cfg: Config; deps: AdminDeps } {
  const root = mkdtempSync(join(tmpdir(), "agent-admin-"));
  const cfg = parseConfig(BASE, root);
  mkdirSync(join(root, "identity", "amendments", "archive", "2026-09-20-amendment"), { recursive: true });
  writeFileSync(join(root, "identity", "DNA.md"), DNA);
  writeFileSync(join(root, "identity", "DNA.template.md"), "# TEMPLATE\n\nThis is a TEMPLATE.\n");
  writeFileSync(join(root, "agent.config.json"), JSON.stringify(BASE));
  writeFileSync(join(root, "catalogue.json"), "[]");
  const arch = join(root, "identity", "amendments", "archive", "2026-09-20-amendment");
  writeFileSync(
    join(arch, "amendment.json"),
    JSON.stringify({ id: "2026-09-20-amendment", at: "2026-09-20T06:00:00.000Z", model: "anthropic/claude-sonnet-4.5", signalsThrough: "2026-09-20T06:00:00.000Z", signalCount: 5, published: 1, rejected: 4, warnings: [], diff: { added: 2, removed: 1 }, costUsd: 0.08, status: "rejected", decidedAt: "2026-09-21T09:00:00.000Z", note: "the restraint stays" }),
  );
  writeFileSync(join(arch, "proposal.md"), "Soften **P1**.\n");
  writeFileSync(join(arch, "DNA.proposed.md"), DNA.replace("Acts on attention.", "Acts loudly."));
  const work = join(root, "workspace", "published", "2026-10-01-fixture-work");
  mkdirSync(work, { recursive: true });
  for (const d of ["pending", "rejected", "orphaned"]) mkdirSync(join(root, "workspace", d), { recursive: true });
  writeFileSync(join(work, "index.html"), "<!doctype html><p>work</p>");
  writeFileSync(join(work, "motivation.md"), "m");
  writeFileSync(join(work, "meta.json"), JSON.stringify({ title: "Fixture Work", summary: "s", mechanism: "m", principles: ["P1"], references: ["R"], license: "CC BY-SA 4.0" }));
  writeFileSync(
    join(work, "jury.json"),
    JSON.stringify({ work_id: "x", gates: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true }, scores: { novelty: 4, nuance: 4, narrative: 4, craft: 4, wit: 4 }, weighted_total: 40, max_weighted: 50, verdict: "strong", references_named: [], principles_invoked: [], rationale: "r", reservations: null, revision_suggestion: null, jury_model: "minimax/minimax-m3" }),
  );
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(
    join(root, "logs", "usage.jsonl"),
    [
      { at: "2026-10-25T06:00:00.000Z", purpose: "generate", model: "anthropic/claude-sonnet-4.5", run: "r1", ok: true, promptTokens: 9000, completionTokens: 4000, costUsd: 0.087, ms: 30000, provider: "Anthropic" },
      { at: "2026-10-25T06:05:00.000Z", purpose: "jury", model: "minimax/minimax-m3", run: "j1", ok: false, promptTokens: 0, completionTokens: 0, costUsd: null, ms: 900, error: "OpenRouter 502: upstream" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const deps: AdminDeps = {
    config: () => parseConfig(JSON.parse(readFileSync(join(root, "agent.config.json"), "utf8")), root),
    catalog: async () => catalog(),
    endpoints: async () => ({ endpoints: [{ provider_name: "Anthropic", context_length: 200_000, uptime_last_30m: 100 }] }),
    keyInfo: async () => null,
    probe: async () => ({ status: 200, title: "vana · pending" }),
    daemonPids: async () => [],
    history: async (_cwd, path) =>
      path.endsWith("DNA.md")
        ? [
            { hash: "b".repeat(40), date: "2026-10-12T11:00:00Z", subject: "dna: hand edit" },
            { hash: "a".repeat(40), date: "2026-08-02T10:00:00Z", subject: "dna: initial" },
          ]
        : [{ hash: "c".repeat(40), date: "2026-08-01T09:00:00Z", subject: "scaffold", }],
    fileAt: async (_cwd, rev, path) =>
      path.endsWith("DNA.md") ? (rev.startsWith("a") ? DNA.replace("Acts on attention.", "Acts at first.") : DNA) : JSON.stringify(BASE),
    fileStatus: async () => "modified",
    env: {},
    now: () => NOW,
  };
  return { root, cfg, deps };
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead(code: number, headers?: Record<string, string>): MockRes;
  end(chunk?: string): void;
}

async function get(deps: AdminDeps, url: string, method = "GET", host?: string): Promise<MockRes> {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
  const headers = host ? { host } : {};
  await handleAdmin({ method, url, headers } as unknown as IncomingMessage, res as unknown as ServerResponse, deps);
  return res;
}

test("admin console routes (hermetic)", async (t) => {
  const { root, deps } = fixture();
  try {
    await t.test("GET / — overview with the DNA, the models, and what needs attention", async () => {
      const r = await get(deps, "/");
      assert.equal(r.statusCode, 200);
      assert.match(r.headers["Content-Security-Policy"] ?? "", /default-src 'none'/);
      assert.match(r.body, /Artistic DNA — Fixture &lt;Artist&gt;/);
      assert.doesNotMatch(r.body, /<script>alert/, "DNA content is escaped");
      assert.match(r.body, /Needs attention/);
      assert.match(r.body, /dimension &quot;wit&quot;: DNA says ×2, config weights it ×1/);
      assert.match(r.body, /OPENROUTER_API_KEY is not set/);
      assert.match(r.body, /answered by another agent \(“vana · pending”\)/);
      assert.match(r.body, /failed OpenRouter call/);
    });

    await t.test("GET /dna — rubric coupling, principles, the rendered document", async () => {
      const r = await get(deps, "/dna");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /The rubric, as the harness reads it/);
      assert.match(r.body, /<b>P1<\/b>Attention/);
      assert.match(r.body, /weight differs/);
      assert.match(r.body, /uncommitted edits/);
      assert.match(r.body, /<h2 id="1-one-line-essence">/);
    });

    await t.test("GET /dna.md — the raw document", async () => {
      const r = await get(deps, "/dna.md");
      assert.equal(r.statusCode, 200);
      assert.match(r.headers["Content-Type"] ?? "", /text\/plain/);
      assert.equal(r.body, DNA);
    });

    await t.test("GET /history — commits and petitions on one timeline", async () => {
      const r = await get(deps, "/history");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /petition declined/);
      assert.match(r.body, /the restraint stays/);
      assert.match(r.body, /href="\/history\/bbbbbbbbbbbb"/);
    });

    await t.test("GET /history/:rev — that version diffed against today's", async () => {
      const r = await get(deps, "/history/aaaaaaa");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /dna: initial/);
      assert.match(r.body, /class="del">− - \*\*P1 — Attention\.\*\* Acts at first\./);
      assert.equal((await get(deps, "/history/1234567")).statusCode, 404);
      assert.equal((await get(deps, "/history/not-a-hash")).statusCode, 404);
    });

    await t.test("GET /models — who does what, fitness, invariants, the ledger", async () => {
      const r = await get(deps, "/models");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /Who does what/);
      assert.match(r.body, /Generate a candidate/);
      assert.match(r.body, /Draft a DNA petition/);
      assert.match(r.body, /Two vendors, always — generator \(anthropic\)/);
      assert.match(r.body, /no JSON mode/, "minimax fixture lacks response_format");
      assert.match(r.body, /OpenRouter 502: upstream/);
      assert.match(r.body, /The jury&#39;s record|The jury's record/);
    });

    await t.test("GET /model?id= — lookup with role fitness and providers", async () => {
      const r = await get(deps, "/model?id=anthropic/claude-sonnet-4.5");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /Fitness by role/);
      assert.match(r.body, /As a juror/);
      assert.match(r.body, /<td>Anthropic/);
      const unknown = await get(deps, "/model?id=nobody/nothing");
      assert.match(unknown.body, /is not in the OpenRouter catalogue/);
      const blank = await get(deps, "/model");
      assert.match(blank.body, /Is a model fit for a role\?/);
    });

    await t.test("GET /prompts — the real prompt builders, with placeholders", async () => {
      const r = await get(deps, "/prompts");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /You are the GENERATOR agent/);
      assert.match(r.body, /You are the JURY agent/);
      assert.match(r.body, /the candidate&#39;s complete index\.html|the candidate's complete index\.html/);
      assert.match(r.body, /You are the studio agent of a working artist/);
    });

    await t.test("GET /config — effective config, defaults, environment", async () => {
      const r = await get(deps, "/config");
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /Effective configuration/);
      assert.match(r.body, /Filled in from defaults/);
      assert.match(r.body, /<code>admin<\/code>|<code>paths\.usage<\/code>/);
    });

    await t.test("JSON APIs parse", async () => {
      for (const url of ["/api/overview.json", "/api/models.json", "/api/dna.json"]) {
        const r = await get(deps, url);
        assert.equal(r.statusCode, 200, url);
        assert.ok(JSON.parse(r.body), url);
      }
      const dna = JSON.parse((await get(deps, "/api/dna.json")).body);
      assert.equal(dna.analysis.version, "0.3");
    });

    await t.test("read-only: anything but GET/HEAD is refused", async () => {
      const r = await get(deps, "/", "POST");
      assert.equal(r.statusCode, 405);
      assert.equal(r.headers.Allow, "GET, HEAD");
    });

    await t.test("only answers to a local Host (DNS-rebinding guard)", async () => {
      assert.equal((await get(deps, "/api/overview.json", "GET", "evil.example:4747")).statusCode, 421);
      assert.equal((await get(deps, "/", "GET", "localhost:4747")).statusCode, 200);
      assert.equal((await get(deps, "/", "GET", "127.0.0.1:4747")).statusCode, 200);
      assert.equal((await get(deps, "/", "GET", "[::1]:4747")).statusCode, 200);
    });

    await t.test("unknown paths 404", async () => {
      assert.equal((await get(deps, "/nope")).statusCode, 404);
    });

    await t.test("an invalid config renders the validation error, not a crash", async () => {
      const broken: AdminDeps = {
        ...deps,
        config: () => parseConfig({ ...BASE, models: { generator: "" } }, root),
      };
      const r = await get(broken, "/models");
      assert.equal(r.statusCode, 500);
      assert.match(r.body, /does not validate/);
      assert.match(r.body, /models\.generator: /, "zod issues are listed by path");
    });

    await t.test("no DNA: the template is shown and the overview fails loudly", async () => {
      rmSync(join(root, "identity", "DNA.md"));
      const r = await get(deps, "/dna");
      assert.match(r.body, /No DNA at <code>identity\/DNA\.md<\/code>/);
      assert.match(r.body, /This is a TEMPLATE/);
      const o = await get(deps, "/");
      assert.match(o.body, /no artistic DNA at identity\/DNA\.md/);
      assert.equal((await get(deps, "/dna.md")).statusCode, 404);
      writeFileSync(join(root, "identity", "DNA.md"), DNA);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed records degrade, never 500", async () => {
  const { root, deps } = fixture();
  try {
    writeFileSync(join(root, "catalogue.json"), "{}"); // valid JSON, not an array
    const arch = join(root, "identity", "amendments", "archive", "2026-09-20-amendment", "amendment.json");
    writeFileSync(arch, JSON.stringify({ id: "2026-09-20-amendment", at: "2026-09-20T06:00:00.000Z", status: "rejected" }));
    for (const url of ["/", "/models", "/prompts", "/history", "/dna"]) {
      assert.equal((await get(deps, url)).statusCode, 200, url);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent whose name needs escaping isn't mistaken for a foreign gateway", async () => {
  const { root, deps } = fixture();
  try {
    const raw = JSON.parse(readFileSync(join(root, "agent.config.json"), "utf8"));
    writeFileSync(join(root, "agent.config.json"), JSON.stringify({ ...raw, name: "Smith & Wesson" }));
    // the real probe decodes the gateway's escaped <title>
    const own: AdminDeps = { ...deps, probe: async () => ({ status: 200, title: decodeEntities("Smith &amp; Wesson · pending") }) };
    assert.doesNotMatch((await get(own, "/")).body, /answered by another agent/);
    assert.match((await get(deps, "/")).body, /answered by another agent/, "vana still is foreign");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guidance window counts undated, hand-written entries like the generator does", () => {
  const entries = guidanceEntries("# Artist guidance\n\n> header\n\n## Standing direction\nAlways quiet.\n\n## 2026-10-01 — rejected \"X\"\nToo loud.\n");
  assert.deepEqual(entries.map((e) => e.date), [null, "2026-10-01"]);
});

test("absolute vendored-library paths resolve like vendor.ts does", () => {
  const { root, cfg } = fixture();
  try {
    const lib = join(root, "vendor-abs.js");
    writeFileSync(lib, "/* lib */");
    const env = gatherEnv({ ...cfg, technologies: { ...cfg.technologies, libraries: { abs: lib, rel: "vendor-abs.js", gone: "nope.js" } } }, null, {});
    assert.deepEqual(env.libraries.map((l) => [l.name, l.exists]), [["abs", true], ["rel", true], ["gone", false]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectChecks ranks the most severe first", async () => {
  const { root, cfg, deps } = fixture();
  try {
    const o = await gatherOverview(cfg, deps);
    const levels = o.checks.map((c) => c.level);
    const rank = { fail: 3, warn: 2, info: 1, ok: 0 } as const;
    for (let i = 1; i < levels.length; i++) assert.ok(rank[levels[i - 1]!] >= rank[levels[i]!]);
    assert.deepEqual(collectChecks({ ...o }).length, o.checks.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatting helpers", () => {
  assert.equal(usd(0), "$0");
  assert.equal(usd(0.00421), "$0.0042");
  assert.equal(usd(0.5), "$0.500");
  assert.equal(usd(12.345), "$12.35");
  assert.equal(usd(null), "—");
  assert.equal(tok(950), "950");
  assert.equal(tok(1450), "1.4k");
  assert.equal(tok(1_050_000), "1.05M");
  assert.equal(rel("2026-10-26T09:00:00Z", NOW), "3 h ago");
  assert.equal(rel("2026-10-29T12:00:00Z", NOW), "in 3 d");
  assert.equal(maskKey("sk-or-v1-0123456789abcdef"), "sk-or-v1-…cdef");
  assert.deepEqual(defaultedKeys({ a: 1, b: { c: 1 } }, { a: 1, b: { c: 1, d: 2 }, e: 3 }), ["b.d", "e"]);
});
