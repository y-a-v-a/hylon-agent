---
title: "Artistic DNA — <your name / alias>"
subject: "A source document describing the artistic identity, principles, methods, and validation criteria of <artist>, for use by generative and evaluative AI agents."
artist: "<your name>"
aliases: []
medium: "<your medium — this harness produces single self-contained web pages (HTML/CSS/JS)>"
license_default: "<e.g. CC BY-SA 4.0 — stated on every work>"
version: "0.1"
date: "<YYYY-MM-DD>"
intended_use: "Seed/source for (1) a generator agent that produces new works in this DNA, (2) a jury agent that validates candidate works against this DNA, (3) a human-in-the-loop confirmation step before publishing."
---

# Artistic DNA — <your name>

> This is a TEMPLATE. Copy it to `identity/DNA.md` and replace every section
> with your own artistic identity. Read it as an operating system, not a
> biography: it must define *how* a work earns the right to be called "in the
> DNA", precisely enough that one agent can generate against it and another can
> judge against it.
>
> **Coupling to the harness:** the hard-gate ids (§8.1) and the scored
> dimensions (§8.2) must match `rubric.gates` and `rubric.weights` in
> `agent.config.json`. The harness computes the weighted total and the verdict;
> this document defines what the gates and dimensions MEAN. Change one, change
> the other.

## 0. How to use this document (for agents)

1. **Generator agent** — read sections 1 to 6 to produce candidate works. Each
   candidate must come with a short rationale mapping it to the principles
   (section 3) and at least one named reference (section 5).
2. **Jury agent** — score each candidate with the rubric in section 8. Apply the
   hard gates first (a single gate failure rejects the work regardless of
   score). Output a structured verdict.
3. **Human confirmation** — the artist reviews jury-passed works and confirms
   publication. Nothing publishes without this step.

State here the single most important rule of your practice — the one test every
work must survive.

## 1. One-line essence

One sentence: who you are as an artist and what a work of yours *does*.

## 2. Identity and stance

- **Who:** background, training, the practice's home on the web.
- **Voice:** how the work sounds — tone, temperament, what it never is.
- **Manifesto lines (treat as canon):** 2–5 short lines the agents can quote.
- **Ethics embedded in the work:** licensing, privacy, delivery — whatever is
  non-negotiable.

## 3. Core principles (the operating system)

Give each principle an ID (P1, P2, …). Generator and jury must reference these
by ID. Aim for 5–10; each one should be a *test*, not a mood.

- **P1 — <name>.** <what it demands; what failing it looks like>
- **P2 — <name>.** …
- **P3 — <name>.** …

## 4. Primary evaluation lenses

Define what each scored dimension from `agent.config.json` means *in your
practice* — one subsection per dimension (default: novelty, nuance, narrative,
craft, wit). For each, also say what it is **not**, so the jury can't reward the
wrong thing.

### <dimension 1>
…

### <dimension 2>
…

## 5. Methods, lineage, and references

### Recurring methods (pick at least one per new work)
- **<method>** (P-ids): …

### Lineage map (the patron saints)
- **<artist / work / tradition>** — why it matters to this practice.

## 6. Material and constraint defaults

- **Medium:** works produced by this harness are single self-contained web
  pages — all CSS/JS inline, zero external requests. Add your own constraints
  on top (form factor, size, palette, interaction…).
- **Technology palette:** the *available* technologies (browser APIs, vendored
  libraries like Three.js) are declared in `agent.config.json` under
  `technologies` — that is mechanics. Use this section for the taste side:
  when a heavier technology is justified, and when restraint wins.
- **License:** what every work must state, verbatim.
- **Attribution:** who/what must be credited on the page.
- **Tone:** the register the work itself must hold.

## 7. Catalogue (reference corpus)

Optionally list your existing works so the jury's duplicate gate has a corpus
and the generator doesn't re-tread. Put them in
`identity/catalogue.seed.json` as:

```json
[
  { "id": "slug", "title": "Title", "year": 2020, "source": "referenced idea/artist", "mechanism": "why it's in the DNA" }
]
```

then run `npm run seed`. You can mirror the list here in prose for the agents'
context.

## 8. Validation rubric (for the jury agent)

### 8.1 Hard gates (any failure = reject, no score)

One entry per gate id in `agent.config.json` (`rubric.gates`, default G1–G6).
Make each a yes/no question with teeth.

- **G1 <name>:** …
- **G2 <name>:** …
- **G3 <name>:** …
- **G4 <name>:** …
- **G5 <name>:** …
- **G6 Not a duplicate:** materially distinct from the existing catalogue
  (section 7) in source, mechanism, or argument. (Keep a gate like this — the
  harness feeds the jury the catalogue for exactly this check.)

### 8.2 Scored criteria (0 to `scoreMax` each)

One entry per dimension in `rubric.weights`, with its weight, e.g.:

- **novelty (weight ×3):** …
- **nuance (weight ×3):** …
- **narrative (weight ×2):** …
- **craft (weight ×1):** …
- **wit (weight ×1):** …

### 8.3 Thresholds (tune with the artist)

Mirror `thresholds` in `agent.config.json` (defaults: ≥38 strong, 30–37
borderline, <30 or any gate fails = reject, out of a 50 max).

### 8.4 Anti-patterns (auto-flag, usually reject)

List the failure modes you see coming: the pretty-but-empty, the derivative,
the over-built, the off-voice. The jury should recognize them by name.

## 9. Publication workflow

Describe what publication means for you (domain, catalogue page, attribution
line, the note that the work is AI-generated and DNA-validated). The harness
handles the mechanics: generate → jury → your approval → `workspace/published/`
→ the assembled public site.

## 10. Quick checklist (for fast generation)

A candidate is plausibly "in the DNA" if you can answer yes to all:
- <question mapping to a gate>
- <question mapping to a principle>
- …

---

*State your sources and the date. This document is a working model of the
artist's DNA, intended to evolve — update the version and date when revised.*
