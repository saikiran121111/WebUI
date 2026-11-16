/**
 * range-math.ts (F06, 2026-11-16) - coordinate algebra for bounded views.
 *
 * A "view" is a subset of a source document expressed as the kept byte spans
 * of the original, joined with "\n\n" (the segment filter's output shape).
 * Every consumer that wants to hand back source text by ADDRESS - focus
 * windows, continuation reads, omitted-block recovery - needs the same two
 * facts: which canonical ranges a view-relative span covers, and which
 * canonical ranges a whole block has NOT handed out yet.
 *
 * Leaf module on purpose: the filter hop is replaced by test doubles across
 * the web-tool suites, and address math must survive those doubles intact
 * rather than being silently mocked away with it.
 */

/** Map [start, end) spans stated in JOINED-VIEW coordinates onto canonical
 *  source coordinates. `kept` are the canonical spans whose slices, joined
 *  with the two-char "\n\n" separator, ARE the view text. A view span that
 *  crosses a synthetic join yields one canonical span per segment it touched
 *  - that is honest: the served text really did come from both. */
export function mapSpansThroughKept(
  kept: Array<[number, number]>,
  spans: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let viewPos = 0;
  for (const [cs, ce] of kept) {
    const len = ce - cs;
    for (const [a, b] of spans) {
      const ia = Math.max(a, viewPos);
      const ib = Math.min(b, viewPos + len);
      if (ia < ib) out.push([cs + (ia - viewPos), cs + (ib - viewPos)]);
    }
    viewPos += len + 2; // the "\n\n" join between kept blocks
  }
  return out;
}
