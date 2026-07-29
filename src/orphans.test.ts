import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { listOrphans, parkOrphan, readOrphanRecord, writeOrphanRecord, type OrphanRecord } from "./orphans.ts";
import type { Config } from "./config.ts";

const meta = {
  title: "Stranded <Work>",
  summary: "a & b",
  mechanism: "m",
  principles: ["P1"],
  references: ["R"],
  license: "CC BY-SA 4.0",
};

const record: OrphanRecord = {
  id: "2026-07-27-stranded-work",
  at: "2026-07-27T12:00:00.000Z",
  error: "OpenRouter returned no content",
  violations: [],
  costUsd: 1.23,
};

function fixture(): { root: string; cfg: Config } {
  const root = mkdtempSync(join(tmpdir(), "agent-orphans-"));
  return { root, cfg: { abs: { orphaned: join(root, "orphaned") } } as unknown as Config };
}

test("listOrphans returns [] when the dir does not exist", () => {
  const { root, cfg } = fixture();
  try {
    assert.deepEqual(listOrphans(cfg), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeOrphanRecord/readOrphanRecord round-trip", () => {
  const { root, cfg } = fixture();
  try {
    const dir = join(cfg.abs.orphaned, record.id);
    mkdirSync(dir, { recursive: true });
    writeOrphanRecord(dir, record);
    assert.deepEqual(readOrphanRecord(dir), record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOrphanRecord returns null when there is no record", () => {
  const { root, cfg } = fixture();
  try {
    const dir = join(cfg.abs.orphaned, record.id);
    mkdirSync(dir, { recursive: true });
    assert.equal(readOrphanRecord(dir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listOrphans lists well-formed dirs, skips malformed ones, and sorts by id", () => {
  const { root, cfg } = fixture();
  try {
    for (const id of ["2026-07-27-b", "2026-07-26-a"]) {
      const dir = join(cfg.abs.orphaned, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
      writeOrphanRecord(dir, { ...record, id });
    }
    // no meta.json → skipped rather than thrown on
    mkdirSync(join(cfg.abs.orphaned, "2026-07-25-broken"), { recursive: true });

    const items = listOrphans(cfg);
    assert.deepEqual(
      items.map((i) => i.id),
      ["2026-07-26-a", "2026-07-27-b"],
    );
    assert.equal(items[0]!.meta.title, "Stranded <Work>");
    assert.equal(items[0]!.orphan?.error, "OpenRouter returned no content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parkOrphan keeps the whole generated work and records why it was stranded", () => {
  const { root, cfg } = fixture();
  try {
    // A staging dir exactly as the generator leaves it.
    const stage = join(root, ".work", "cand-abc");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "index.html"), "<!doctype html><h1>THE WORK</h1>");
    writeFileSync(join(stage, "motivation.md"), "why");
    writeFileSync(join(stage, "meta.json"), JSON.stringify(meta));

    const dest = parkOrphan(cfg.abs.orphaned, record.id, stage, record);

    assert.equal(dest, join(cfg.abs.orphaned, record.id));
    assert.equal(existsSync(stage), false, "staging dir is moved, not copied");
    // Every generated file survives — this is the whole point.
    assert.match(readFileSync(join(dest, "index.html"), "utf8"), /THE WORK/);
    assert.equal(readFileSync(join(dest, "motivation.md"), "utf8"), "why");
    assert.equal(readOrphanRecord(dest)?.error, "OpenRouter returned no content");
    // It is now visible for recovery.
    assert.deepEqual(listOrphans(cfg).map((i) => i.id), [record.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parkOrphan creates the orphaned root when it does not exist yet", () => {
  const { root, cfg } = fixture();
  try {
    const stage = join(root, ".work", "cand-xyz");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "meta.json"), JSON.stringify(meta));
    assert.equal(existsSync(cfg.abs.orphaned), false);
    parkOrphan(cfg.abs.orphaned, record.id, stage, record);
    assert.ok(existsSync(join(cfg.abs.orphaned, record.id)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listOrphans tolerates a work with no orphan record", () => {
  const { root, cfg } = fixture();
  try {
    const dir = join(cfg.abs.orphaned, "2026-07-27-no-record");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    const items = listOrphans(cfg);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.orphan, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
