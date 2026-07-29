import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";

// Accumulated artist guidance, grown from reject-with-note. The GENERATOR reads
// recent entries each round and steers by them; the JURY never reads it (the
// gate stays on DNA §8 alone). The file is human-editable — prune/curate freely.

const HEADER =
  "# Artist guidance — accumulated from rejection notes\n\n" +
  "> The generator reads recent entries each round and treats them as direction.\n" +
  "> The jury does not read this. Edit or prune freely.\n";

export function loadGuidance(): string {
  const p = loadConfig().abs.guidance;
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Append a dated rejection note keyed to the work it came from. */
export function appendGuidance(title: string, note: string, now: Date): void {
  const p = loadConfig().abs.guidance;
  if (!existsSync(p)) writeFileSync(p, HEADER, "utf8");
  const entry = `\n## ${now.toISOString().slice(0, 10)} — rejected "${title}"\n${note.trim()}\n`;
  appendFileSync(p, entry, "utf8");
}

/**
 * The most recent N guidance entries, for the generator prompt (bounds size).
 * Splits on the `## ` headers; returns "" when there's no guidance yet.
 */
export function recentGuidance(text: string, n = 20): string {
  const entries = text
    .split(/\n(?=## )/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("## ")); // keep real entries; drop the file header/blockquote
  return entries.slice(-n).join("\n\n");
}
