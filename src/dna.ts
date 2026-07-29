import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";

/** The artistic DNA — the operating system for both generator and jury. */
export function loadDna(): string {
  return readFileSync(loadConfig().abs.dna, "utf8");
}
