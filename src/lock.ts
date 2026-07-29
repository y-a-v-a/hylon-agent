// Minimal in-process mutex. Serializes async sections within a single process —
// e.g. the daemon's scheduled wake and a dashboard-triggered refine, which both
// drive the generator and `git`. (Cross-process — a separate `npm run once` —
// is out of scope here; that race window is tiny and accepted.)
let tail: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain after whatever is queued, regardless of its outcome, so one failure
  // doesn't wedge the lock.
  const run = tail.then(fn, fn);
  tail = run.then(
    () => {},
    () => {},
  );
  return run;
}
