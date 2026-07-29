import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";

/** The artistic DNA — the operating system for both generator and jury. */
export function loadDna(): string {
  const cfg = loadConfig();
  if (!existsSync(cfg.abs.dna)) {
    throw new Error(
      `No artistic DNA found at ${cfg.paths.dna}. ` +
        `Copy identity/DNA.template.md to ${cfg.paths.dna} and make it yours — ` +
        `the DNA is the only taste authority; the harness encodes none of its own.`,
    );
  }
  return readFileSync(cfg.abs.dna, "utf8");
}
