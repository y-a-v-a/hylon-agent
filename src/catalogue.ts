import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";

/**
 * The catalogue is the living index of every work the system knows about:
 * - `historical` — the artist's pre-existing corpus, seeded from the optional
 *   `identity/catalogue.seed.json`. Used by the jury's not-a-duplicate gate and
 *   by the generator to avoid re-treading.
 * - `pending` | `published` | `rejected` — works produced by this harness.
 * - `orphaned` — generated, but stranded before a verdict (see orphans.ts). Listed
 *   so the catalogue always mirrors the filesystem, and so the generator's digest
 *   knows the idea is already spent.
 *
 * Both the generator and the jury read it.
 */
export type CatalogueStatus = "historical" | "pending" | "published" | "rejected" | "orphaned";

export interface CatalogueEntry {
  id: string;
  title: string;
  year: number | string;
  source: string; // referenced idea / artist
  mechanism: string; // why it's in the DNA (the mechanism that carries the idea)
  status: CatalogueStatus;
}

/**
 * Seed the catalogue. If `identity/catalogue.seed.json` exists (an array of
 * entries without `status`), those become the `historical` corpus; otherwise
 * the catalogue starts empty and grows as the agent works.
 */
export function seedCatalogue(): CatalogueEntry[] {
  const cfg = loadConfig();
  if (existsSync(cfg.abs.catalogue)) {
    return loadCatalogue();
  }
  let entries: CatalogueEntry[] = [];
  if (existsSync(cfg.abs.catalogueSeed)) {
    const seed = JSON.parse(readFileSync(cfg.abs.catalogueSeed, "utf8")) as Omit<
      CatalogueEntry,
      "status"
    >[];
    entries = seed.map((e) => ({ ...e, status: "historical" }));
  }
  writeCatalogue(entries);
  return entries;
}

export function loadCatalogue(): CatalogueEntry[] {
  const cfg = loadConfig();
  if (!existsSync(cfg.abs.catalogue)) return [];
  return JSON.parse(readFileSync(cfg.abs.catalogue, "utf8")) as CatalogueEntry[];
}

export function writeCatalogue(entries: CatalogueEntry[]): void {
  const cfg = loadConfig();
  writeFileSync(cfg.abs.catalogue, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** Append or update an entry by id, then persist. */
export function upsertEntry(entry: CatalogueEntry): CatalogueEntry[] {
  const entries = loadCatalogue();
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeCatalogue(entries);
  return entries;
}

/** Compact view for prompting the generator/jury: "Title (year) — source — mechanism". */
export function catalogueDigest(entries = loadCatalogue()): string {
  return entries
    .map((e) => `- ${e.title} (${e.year}) — ${e.source} — ${e.mechanism}`)
    .join("\n");
}

// CLI: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "seed") {
    const entries = seedCatalogue();
    console.log(`Seeded catalogue with ${entries.length} entries.`);
  } else {
    console.error(`Unknown command: ${cmd ?? "(none)"}. Try: seed`);
    process.exit(1);
  }
}
