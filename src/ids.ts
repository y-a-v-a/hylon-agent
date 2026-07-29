/** Slugify a title into a URL/filesystem-safe token (lowercase, hyphenated, ASCII). */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** UTC calendar date as YYYY-MM-DD. Date is passed in for deterministic testing. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Candidate id: `<UTC-date>-<title-slug>`, e.g. "2026-06-16-but-is-it-art".
 * Stable, sortable, human-legible. Empty slugs fall back to "untitled".
 */
export function makeId(title: string, date: Date): string {
  return `${isoDate(date)}-${slugify(title) || "untitled"}`;
}

/**
 * True only for ids of the exact shape `makeId()` produces: `YYYY-MM-DD-<slug>`
 * with a lowercase, hyphen-separated alphanumeric slug (the `-2`, `-3`, …
 * uniqueness suffix is covered). Use this to validate untrusted HTTP input
 * before it is joined into a filesystem path — it admits no `.`, `/`, or `\`,
 * so it cannot express path traversal.
 */
export function isValidId(id: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}
