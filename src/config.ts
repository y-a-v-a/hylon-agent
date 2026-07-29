import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Repo root = parent of src/. All config paths resolve relative to it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadDotenv({ path: resolve(ROOT, ".env") });

const RubricSchema = z.object({
  /** Hard-gate ids the jury must answer as booleans (any failure = reject). */
  gates: z.array(z.string().min(1)).min(1),
  /** Scored dimensions and their weights; the DNA defines what they mean. */
  weights: z.record(z.string().min(1), z.number().positive()),
  /** Per-dimension score ceiling (scores are integers 0..scoreMax). */
  scoreMax: z.number().int().positive().default(5),
});

export type Rubric = z.infer<typeof RubricSchema>;

/** Maximum achievable weighted total for a rubric. */
export function maxWeighted(rubric: Rubric): number {
  return rubric.scoreMax * Object.values(rubric.weights).reduce((a, b) => a + b, 0);
}

const ConfigSchema = z.object({
  /** Display name of this agent (dashboard header, email subjects, X-Title). */
  name: z.string().min(1).default("agent"),
  interval: z.object({ hours: z.number().positive() }),
  workBudget: z.object({ minutes: z.number().positive() }),
  costFuse: z.object({
    perWakeUsd: z.number().positive(),
    perDayUsd: z.number().positive(),
  }),
  /** OpenRouter model ids for both agents. Keep them different vendors. */
  models: z.object({
    generator: z.string().min(1),
    jury: z.string().min(1),
  }),
  generation: z
    .object({
      /**
       * "agentic" (default): a file-tool loop — the model writes/reads its own
       * files and self-corrects; needs a model with tool-calling support.
       * "single-shot": one completion carrying three delimited sections; for
       * models without tool support.
       */
      mode: z.enum(["agentic", "single-shot"]).default("agentic"),
      /** Agentic mode: max model turns per generation. */
      maxTurns: z.number().int().positive().default(16),
      temperature: z.number().min(0).max(2).default(1),
      /** Max output tokens per completion (per turn in agentic mode). */
      maxTokens: z.number().int().positive().default(32_000),
    })
    .default({ mode: "agentic", maxTurns: 16, temperature: 1, maxTokens: 32_000 }),
  /**
   * The technology palette. `apis` are browser APIs the generator is told are
   * in bounds (pure prompt plumbing — the only hard limit stays "zero external
   * requests"). `libraries` maps a name to a vendored file in the repo, used
   * via a `<script data-vendor="name"></script>` placeholder that the harness
   * inlines at render/build time (see vendor.ts).
   */
  technologies: z
    .object({
      apis: z.array(z.string()).default(["svg", "canvas-2d", "webgl", "webaudio", "css-animation"]),
      libraries: z.record(z.string().min(1), z.string().min(1)).default({}),
    })
    .default({
      apis: ["svg", "canvas-2d", "webgl", "webaudio", "css-animation"],
      libraries: {},
    }),
  rubric: RubricSchema,
  thresholds: z.object({
    strong: z.number(),
    borderline: z.number(),
  }),
  /**
   * Self-amending DNA: the agent may PETITION to update identity/DNA.md when
   * accumulated signals (rejection notes, refinement requests) suggest the
   * artist's wishes have shifted. A petition is a proposal at the human gate —
   * approval is the only thing that ever rewrites the DNA.
   */
  amendments: z
    .object({
      enabled: z.boolean().default(true),
      /** Minimum new signals since the last proposal before the agent may petition. */
      minSignals: z.number().int().positive().default(5),
      /** OpenRouter model for drafting proposals; empty = models.generator. */
      model: z.string().default(""),
    })
    .default({ enabled: true, minSignals: 5, model: "" }),
  paths: z.object({
    dna: z.string(),
    catalogue: z.string(),
    catalogueSeed: z.string().default("identity/catalogue.seed.json"),
    guidance: z.string(),
    amendments: z.string().default("identity/amendments"),
    pending: z.string(),
    published: z.string(),
    rejected: z.string(),
    // Works the generator finished but that never reached a verdict (see orphans.ts).
    orphaned: z.string().default("workspace/orphaned"),
  }),
  dashboard: z.object({
    port: z.number().int().positive(),
    /** Hostname used in emailed links (e.g. a tailnet host); empty = localhost. */
    host: z.string().default(""),
  }),
  /** Recipient for notifications; empty = console-log instead of email. */
  email: z.object({ to: z.string() }).default({ to: "" }),
  git: z.object({ remote: z.string(), branch: z.string(), push: z.boolean().default(true) }),
  site: z
    .object({
      title: z.string().default("machine works"),
      lede: z.string().default(""),
      footer: z.string().default(""),
    })
    .default({ title: "machine works", lede: "", footer: "" }),
  /** Optional OpenRouter attribution headers (HTTP-Referer / X-Title). */
  openrouter: z
    .object({
      referer: z.string().default(""),
      title: z.string().default(""),
    })
    .default({ referer: "", title: "" }),
});

export type Config = z.infer<typeof ConfigSchema> & {
  /** Absolute filesystem paths, resolved from `paths` against the repo root. */
  abs: {
    root: string;
    dna: string;
    catalogue: string;
    catalogueSeed: string;
    guidance: string;
    amendments: string;
    pending: string;
    published: string;
    rejected: string;
    orphaned: string;
  };
};

export type Smtp = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(resolve(ROOT, "agent.config.json"), "utf8"));
  const parsed = ConfigSchema.parse(raw);
  cached = {
    ...parsed,
    abs: {
      root: ROOT,
      dna: resolve(ROOT, parsed.paths.dna),
      catalogue: resolve(ROOT, parsed.paths.catalogue),
      catalogueSeed: resolve(ROOT, parsed.paths.catalogueSeed),
      guidance: resolve(ROOT, parsed.paths.guidance),
      amendments: resolve(ROOT, parsed.paths.amendments),
      pending: resolve(ROOT, parsed.paths.pending),
      published: resolve(ROOT, parsed.paths.published),
      rejected: resolve(ROOT, parsed.paths.rejected),
      orphaned: resolve(ROOT, parsed.paths.orphaned),
    },
  };
  return cached;
}

/**
 * The single required secret: the OpenRouter key both agents connect with.
 * Throws a clear, actionable error when missing.
 */
export function loadOpenRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing OPENROUTER_API_KEY — the base connector key for both the generator " +
        "and the jury. Set it in .env (see .env.example).",
    );
  }
  return key;
}

/**
 * SMTP settings from the environment. Email is OPTIONAL: returns null when the
 * SMTP env is entirely absent (the harness then logs notifications instead).
 * Throws only when it is *partially* configured — that's a mistake worth surfacing.
 */
export function loadSmtp(): Smtp | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  if (!host && !user && !pass) return null;
  const missing: string[] = [];
  if (!host) missing.push("SMTP_HOST");
  if (!user) missing.push("SMTP_USER");
  if (!pass) missing.push("SMTP_PASS");
  if (missing.length > 0) {
    throw new Error(`SMTP partially configured — missing ${missing.join(", ")} (see .env.example).`);
  }
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;
  return {
    host: host!,
    port,
    secure: port === 465,
    user: user!,
    pass: pass!,
    from: process.env.SMTP_FROM?.trim() || user!,
  };
}

export const ROOT_DIR = ROOT;
