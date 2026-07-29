// Dependency-free line diff (LCS) for rendering DNA amendment proposals.
// DNA documents are a few hundred lines, so the O(n·m) table is fine.

export interface DiffOp {
  type: "same" | "del" | "add";
  line: string;
}

export function diffLines(aText: string, bText: string): DiffOp[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  return {
    added: ops.filter((o) => o.type === "add").length,
    removed: ops.filter((o) => o.type === "del").length,
  };
}

export type CollapsedOp = DiffOp | { type: "gap"; count: number };

/**
 * Collapse long unchanged runs, keeping `context` lines around each change —
 * the shape a human wants when reviewing an amendment.
 */
export function collapseOps(ops: DiffOp[], context = 3): CollapsedOp[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type === "same") continue;
    for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) {
      keep[c] = true;
    }
  }
  const out: CollapsedOp[] = [];
  let gap = 0;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      if (gap > 0) {
        out.push({ type: "gap", count: gap });
        gap = 0;
      }
      out.push(ops[k]!);
    } else {
      gap++;
    }
  }
  if (gap > 0) out.push({ type: "gap", count: gap });
  return out;
}

/** Plain-text rendering (for emails/CLI): "  ", "- ", "+ " prefixes and gap markers. */
export function renderDiffText(ops: DiffOp[], context = 3): string {
  return collapseOps(ops, context)
    .map((o) => {
      if (o.type === "gap") return `⋯ ${o.count} unchanged line${o.count === 1 ? "" : "s"} ⋯`;
      const prefix = o.type === "same" ? "  " : o.type === "del" ? "- " : "+ ";
      return prefix + o.line;
    })
    .join("\n");
}
