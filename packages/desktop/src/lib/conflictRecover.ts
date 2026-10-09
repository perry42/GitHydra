// SPDX-License-Identifier: GPL-3.0-or-later
import { classifyConflictMarkerLine, parseConflictText } from "@githydra/git-core";

// specs/edit-in-diff.md FR-557/FR-565: find the blocks of a partly-resolved buffer by lining it up with the file as git first
// wrote it (`ConflictSides.merged`), so a restored draft or a reopened half-saved file still shows Yours/Incoming/... per block.

export interface RecoveredBlock {
  /** The block's current result region in the buffer, in whole lines; empty when the user removed both sides. */
  from: number;
  to: number;
  ours: string;
  theirs: string;
  base: string | null;
}

/**
 * For each line of `a`, the index of the line it matches in `b` (or -1), from a Myers diff. `null` when the two differ by more
 * than `maxD` edits: a buffer that far from the original is not worth guessing about.
 */
export function matchLines(a: readonly string[], b: readonly string[], maxD = 1500): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    match[pre] = pre;
    pre++;
  }
  let sa = a.length;
  let sb = b.length;
  while (sa > pre && sb > pre && a[sa - 1] === b[sb - 1]) {
    sa--;
    sb--;
    match[sa] = sb;
  }
  const n = sa - pre;
  const m = sb - pre;
  if (n === 0 || m === 0) return match;
  const A = a.slice(pre, sa);
  const B = b.slice(pre, sb);
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1]! < V[off + k + 1]!) ? V[off + k + 1]! : V[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= n && y >= m) {
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const v = trace[dd]!;
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && v[off + kk - 1]! < v[off + kk + 1]!) ? kk + 1 : kk - 1;
          const px = v[off + prevK]!;
          const py = px - prevK;
          while (cx > px && cy > py) {
            cx--;
            cy--;
            match[pre + cx] = pre + cy;
          }
          cx = px;
          cy = py;
        }
        while (cx > 0 && cy > 0) {
          cx--;
          cy--;
          match[pre + cx] = pre + cy;
        }
        return match;
      }
    }
  }
  return null;
}

const lf = (s: string): string => s.replace(/\r\n?/g, "\n");

/**
 * The conflicts of `merged` that the buffer `current` no longer shows as markers, with the region each one now occupies.
 * Each is located between the nearest unchanged lines on either side of its original markers, so it works whatever the user
 * typed in between. Anything that cannot be placed with confidence is simply left out (the block then has no chip row).
 */
export function recoverBlocks(merged: string, current: string): RecoveredBlock[] {
  // A buffer with bare CRs (mixed-EOL files) keeps them in the text, so offsets would not line up with a normalised copy.
  if (current.includes("\r")) return [];
  const parsed = parseConflictText(lf(merged));
  if (parsed.blocks.length === 0 || parsed.strayMarkers.length > 0) return [];
  const P = lf(merged).split("\n");
  const T = current.split("\n");
  const match = matchLines(P, T);
  if (!match) return [];
  const starts: number[] = [];
  let at = 0;
  for (const line of T) {
    starts.push(at);
    at += line.length + 1;
  }
  starts.push(current.length);
  const out: RecoveredBlock[] = [];
  let floor = 0;
  for (const b of parsed.blocks) {
    const ms = b.startMarker.line - 1;
    const me = b.endMarker.line - 1;
    const before = ms - 1;
    const after = me + 1;
    // Conflicts with no unchanged line between them cannot be told apart.
    if (before >= 0 && classifyConflictMarkerLine(P[before]!) !== null) continue;
    if (after < P.length && classifyConflictMarkerLine(P[after]!) !== null) continue;
    const lo = before >= 0 ? match[before]! : -1;
    const hi = after < P.length ? match[after]! : T.length;
    if ((before >= 0 && lo < 0) || (after < P.length && hi < 0) || hi <= lo) continue;
    const from = Math.min(starts[lo + 1]!, current.length);
    const to = Math.min(starts[hi]!, current.length);
    if (from < floor || to < from) continue;
    floor = to;
    out.push({ from, to, ours: b.ours.text, theirs: b.theirs.text, base: b.base ? b.base.text : null });
  }
  return out;
}
