import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findModel,
  invariantChecks,
  loadCatalog,
  modelUses,
  perMillion,
  resetCatalogMemo,
  rosterTimeline,
  useChecks,
  vendorOf,
  type Catalog,
  type ModelUse,
  type OpenRouterModel,
} from "./models.ts";
import { parseConfig, type Config } from "./config.ts";

const BASE = JSON.parse(readFileSync(new URL("../agent.config.json", import.meta.url), "utf8"));

function cfgWith(over: (raw: typeof BASE) => void): Config {
  const raw = structuredClone(BASE);
  over(raw);
  return parseConfig(raw, "/tmp/agent-fixture");
}

const model = (over: Partial<OpenRouterModel>): OpenRouterModel => ({
  id: "vendor/model",
  name: "Vendor: Model",
  context_length: 100_000,
  architecture: { output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
  top_provider: { max_completion_tokens: 64_000 },
  supported_parameters: ["tools", "response_format", "temperature", "max_tokens"],
  ...over,
});

const NOW = new Date("2026-10-26T12:00:00Z");
const ctx = { catalogAvailable: true, now: NOW };
const levels = (checks: { level: string; label: string }[], re: RegExp): string[] =>
  checks.filter((c) => re.test(c.label)).map((c) => c.level);

test("vendorOf and perMillion", () => {
  assert.equal(vendorOf("Anthropic/claude-sonnet-4.5"), "anthropic");
  assert.equal(vendorOf("openrouter/auto"), "openrouter");
  assert.equal(perMillion("0.000003"), 3);
  assert.equal(perMillion(undefined), null);
  assert.equal(perMillion("-1"), null);
});

test("findModel: exact id, canonical slug, or the base of a routing variant", () => {
  const cat: Catalog = {
    models: [model({ id: "a/b", canonical_slug: "a/b-20260101" })],
    fetchedAt: null,
    source: "live",
  };
  assert.equal(findModel(cat, "a/b")?.id, "a/b");
  assert.equal(findModel(cat, "a/b-20260101")?.id, "a/b");
  assert.equal(findModel(cat, "a/b:nitro")?.id, "a/b");
  assert.equal(findModel(cat, "a/c"), undefined);
});

test("modelUses mirrors how the harness resolves each role", () => {
  const cfg = cfgWith((r) => {
    r.models.jury = ["minimax/minimax-m3", "openai/gpt-4o", "google/gemini-2.5-flash"];
    r.amendments.model = "";
  });
  const uses = modelUses(cfg);
  assert.deepEqual(
    uses.map((u) => [u.role, u.title, u.model]),
    [
      ["generator", "Generator", cfg.models.generator],
      ["jury", "Juror 1 of 3", "minimax/minimax-m3"],
      ["jury", "Juror 2 of 3", "openai/gpt-4o"],
      ["jury", "Juror 3 of 3", "google/gemini-2.5-flash"],
      ["amend", "Amendment drafter", cfg.models.generator],
    ],
  );
  const gen = uses[0]!;
  assert.deepEqual(gen.purposes, ["generate", "refine"]);
  assert.equal(gen.call.tools, true);
  assert.equal(gen.call.maxTurns, cfg.generation.maxTurns);
  assert.equal(uses[1]!.call.json, true);
  assert.equal(uses[1]!.call.temperature, 0.2);
  assert.match(uses[4]!.inherited ?? "", /amendments\.model is empty/);

  const single = modelUses(cfgWith((r) => (r.generation = { ...r.generation, mode: "single-shot" })));
  assert.equal(single[0]!.call.tools, false);
  assert.equal(single[1]!.title, "Jury");
});

test("useChecks: unknown models fail only when the catalogue could be read", () => {
  const use = modelUses(cfgWith(() => {}))[1]!; // the jury
  assert.deepEqual(levels(useChecks(use, undefined, ctx), /not listed/), ["fail"]);
  assert.deepEqual(
    useChecks(use, undefined, { ...ctx, catalogAvailable: false }).map((c) => c.level),
    ["info"],
  );
});

test("useChecks: a juror must be an exact catalogue id (the wake pre-flight is exact)", () => {
  const [gen, jury] = modelUses(cfgWith(() => {}));
  const base = model({ id: "openai/gpt-4o", name: "GPT-4o" });
  const variant = { ...jury!, model: "openai/gpt-4o:nitro" };
  assert.deepEqual(levels(useChecks(variant, base, ctx), /not an exact catalogue id/), ["fail"]);
  assert.deepEqual(levels(useChecks({ ...gen!, model: "openai/gpt-4o:nitro" }, base, ctx), /resolves to/), ["info"]);
  assert.deepEqual(levels(useChecks({ ...jury!, model: "openai/gpt-4o" }, base, ctx), /listed on OpenRouter/), ["ok"]);
});

test("useChecks: the agentic generator needs tools; the jury wants JSON mode", () => {
  const [gen, jury] = modelUses(cfgWith(() => {}));
  const bare = model({ supported_parameters: ["temperature", "max_tokens"] });
  assert.deepEqual(levels(useChecks(gen!, bare, ctx), /tool calling/), ["fail"]);
  assert.deepEqual(levels(useChecks(jury!, bare, ctx), /JSON mode/), ["warn"]);
  assert.deepEqual(levels(useChecks(gen!, model({}), ctx), /tool calling/), ["ok"]);
});

test("useChecks: temperature, max_tokens, expiry, context, modality", () => {
  const gen: ModelUse = modelUses(cfgWith((r) => (r.generation = { ...r.generation, maxTokens: 100_000 })))[0]!;
  const m = model({ supported_parameters: ["tools", "max_tokens"] });
  const checks = useChecks(gen, m, { ...ctx, promptTokens: 90_000 });
  assert.deepEqual(levels(checks, /temperature/), ["warn"]);
  assert.deepEqual(levels(checks, /exceeds the model's max completion/), ["warn"]);
  assert.deepEqual(levels(checks, /of the context window/), ["warn"]);
  assert.deepEqual(levels(useChecks(gen, m, { ...ctx, promptTokens: 200_000 }), /exceeds the 100,000-token context/), ["fail"]);
  assert.deepEqual(levels(useChecks(gen, model({ expiration_date: "2026-11-30" }), ctx), /expire/), ["warn"]);
  assert.deepEqual(levels(useChecks(gen, model({ expiration_date: "2026-10-01" }), ctx), /expired/), ["fail"]);
  assert.deepEqual(levels(useChecks(gen, model({ architecture: { output_modalities: ["image"] } }), ctx), /does not output text/), ["fail"]);
});

test("invariantChecks: Two vendors, always", () => {
  const ok = invariantChecks(cfgWith((r) => (r.models = { generator: "anthropic/x", jury: "minimax/y" })));
  assert.deepEqual(levels(ok, /Two vendors/), ["ok"]);
  const bad = invariantChecks(cfgWith((r) => (r.models = { generator: "anthropic/x", jury: ["minimax/y", "anthropic/z", "google/w"] })));
  assert.deepEqual(levels(bad, /Two vendors/), ["fail"]);
  assert.match(bad.find((c) => /Two vendors/.test(c.label))!.label, /anthropic\/z/);
});

test("invariantChecks: even panels, duplicate jurors, routers, shared juror vendors", () => {
  const even = invariantChecks(cfgWith((r) => (r.models = { generator: "anthropic/x", jury: ["minimax/y", "google/w"] })));
  assert.deepEqual(levels(even, /even panel/), ["warn"]);
  const dup = invariantChecks(cfgWith((r) => (r.models = { generator: "anthropic/x", jury: ["minimax/y", "minimax/y", "google/w"] })));
  assert.deepEqual(levels(dup, /sits on the panel 2 times/), ["warn"]);
  assert.deepEqual(levels(dup, /several jurors come from one vendor/), [], "duplicates aren't double-reported");
  const shared = invariantChecks(cfgWith((r) => (r.models = { generator: "anthropic/x", jury: ["google/a", "google/b", "minimax/c"] })));
  assert.deepEqual(levels(shared, /several jurors come from one vendor \(google\)/), ["info"]);
  const router = invariantChecks(cfgWith((r) => (r.models = { generator: "anthropic/x", jury: "openrouter/auto" })));
  assert.deepEqual(levels(router, /is a router/), ["warn"]);
});

test("rosterTimeline keeps only the revisions where the roster changed", () => {
  const conf = (gen: string, jury: unknown, amend = ""): string =>
    JSON.stringify({ models: { generator: gen, jury }, amendments: { model: amend } });
  const tl = rosterTimeline([
    // newest first, like git log
    { hash: "d", date: "2026-10-05", subject: "amend model", config: conf("a/g", ["m/1", "k/2"], "o/5") },
    { hash: "c", date: "2026-09-20", subject: "unrelated edit", config: conf("a/g", ["m/1", "k/2"]) },
    { hash: "x", date: "2026-09-15", subject: "broken file", config: "{not json" },
    { hash: "b", date: "2026-09-10", subject: "panel", config: conf("a/g", ["m/1", "k/2"]) },
    { hash: "a", date: "2026-08-01", subject: "initial", config: conf("a/g", "m/1") },
  ]);
  assert.deepEqual(
    tl.map((r) => [r.hash, r.changed]),
    [
      ["d", ["amend"]],
      ["b", ["jury"]],
      ["a", ["generator", "jury", "amend"]],
    ],
  );
  assert.deepEqual(tl[2]!.roster.jury, ["m/1"]);
});

test("loadCatalog: live, then memoized, then the disk copy when offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-catalog-"));
  const cache = join(dir, ".cache", "models.json");
  try {
    resetCatalogMemo();
    let calls = 0;
    const live = async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify({ data: [model({ id: "a/b" })] }), { status: 200 });
    };
    const first = await loadCatalog(cache, { fetcher: live, now: 1_000 });
    assert.equal(first.source, "live");
    assert.equal(first.models[0]!.id, "a/b");
    await loadCatalog(cache, { fetcher: live, now: 2_000 });
    assert.equal(calls, 1, "memoized within the TTL");

    resetCatalogMemo();
    const offline = async (): Promise<Response> => {
      throw new Error("getaddrinfo ENOTFOUND openrouter.ai");
    };
    const cached = await loadCatalog(cache, { fetcher: offline, now: 3_000 });
    assert.equal(cached.source, "cache");
    assert.match(cached.error ?? "", /ENOTFOUND/);
    assert.equal(cached.models.length, 1);

    resetCatalogMemo();
    writeFileSync(cache, "garbage");
    const none = await loadCatalog(cache, { fetcher: offline, now: 4_000 });
    assert.equal(none.source, "none");
    assert.equal(none.models.length, 0);
  } finally {
    resetCatalogMemo();
    rmSync(dir, { recursive: true, force: true });
  }
});
