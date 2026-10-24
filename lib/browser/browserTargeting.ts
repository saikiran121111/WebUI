/**
 * Target resolution + the recovery ladder's DOM half.
 *
 * Turns a typed target (ref / selector / role+name / label / text) into a
 * live Playwright Locator, climbing the fallback ladder honestly:
 *
 *   semantic_dom   → ref from the current snapshot
 *   expanded_dom   → fresh re-index (handles dynamic re-renders / stale refs
 *                    by matching the semantic role+name in the NEW index)
 *   frame_dom      → search across every frame
 *   canvas_only    → detected, handed to the visual-grounding caller
 *
 * Never fabricates a match: >1 candidate is `ambiguous_target`, 0 is
 * `target_not_found`, and every attempt is REPORTED (attempted list +
 * errorClass) so the model's next turn sees exactly what was tried.
 */
import type { Frame, Locator } from "playwright";
import type { Page } from "playwright";
import {
  indexPage,
  currentSnapshot,
  getSnapshot,
  resolveRefLocator,
  resolveTargetLocators,
  type PageSnapshot,
  type ResolvedTarget,
  type TargetSpec,
} from "./domIndexer";
import {
  type BrowserStrategy,
  type FailureClass,
} from "./fallbackController";

export interface LocateResult {
  locator?: Locator;
  frame?: Frame;
  /** True when a stale ref was recovered via semantic re-matching. */
  recovered?: boolean;
  /** The strategy that succeeded. */
  strategy?: BrowserStrategy;
  errorClass?: FailureClass;
  error?: string;
  /** Every strategy tried, in order (reported to the model). */
  attempted: BrowserStrategy[];
  /** Present when the page looks canvas-driven with no DOM targets. */
  canvasOnly?: boolean;
}

async function hasCanvas(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => !!document.querySelector("canvas"));
  } catch {
    return false;
  }
}

/**
 * Stale-ref recovery: after a re-index the old ref id is gone — match the
 * intended element by its semantic (role + name) in the NEW snapshot, but
 * only when that match is UNIQUE (otherwise ambiguous_target).
 */
function recoverRefInSnapshot(
  page: Page,
  fresh: PageSnapshot,
  spec: TargetSpec,
): { locator: Locator; frame: Frame } | null {
  const role = spec.role;
  const name = spec.name;
  if (!role || !name) return null;
  const matches = fresh.refs.filter(
    (r) => r.role === role && r.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length !== 1) return null;
  const hit = resolveRefLocator(page, fresh, matches[0].ref);
  return hit ? { locator: hit.locator, frame: hit.frame } : null;
}

/**
 * Stale-ref identity guard (semantic_dom step): a ref that still resolves
 * to exactly ONE element is trusted only when that element is plausibly
 * the one the model meant. It is SUSPECT — fall through to the
 * expanded_dom recovery instead of acting on it — when:
 *  - the fence pins a `snapshotId` older than the newest snapshot (the
 *    page was re-indexed since; refs may have been re-stamped onto
 *    different controls by a re-render), or
 *  - the model provided `role` + `name` (the fast-path contract) and the
 *    LIVE element's accessible name no longer matches them.
 * Never rejects when the live identity can't be read (inputs, icon-only
 * controls) — an unreadable name is unknown, not a mismatch.
 */
async function refIdentitySuspect(hit: ResolvedTarget, spec: TargetSpec): Promise<boolean> {
  const newest = currentSnapshot();
  if (spec.snapshotId && newest && spec.snapshotId < newest.snapshotId) return true;
  if (spec.role && spec.name) {
    const live = (
      (await hit.locator.getAttribute("aria-label").catch(() => null)) ??
      (await hit.locator.innerText().catch(() => "")) ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (live) {
      const want = spec.name.replace(/\s+/g, " ").trim().toLowerCase();
      if (!want.includes(live) && !live.includes(want)) return true;
    }
  }
  return false;
}

/**
 * Full DOM-side ladder for locating a target. Callers (click/fill/…) then
 * act on `locator`; failure `errorClass` feeds the fallback controller for
 * keyboard / visual-grounding / handoff escalation.
 */
export async function locateTarget(
  page: Page,
  spec: TargetSpec,
): Promise<LocateResult> {
  const attempted: BrowserStrategy[] = [];

  // 1) semantic_dom — ref against its recorded snapshot (or the newest).
  if (spec.ref) {
    attempted.push("semantic_dom");
    const snap = spec.snapshotId ? getSnapshot(spec.snapshotId) : currentSnapshot();
    if (snap) {
      const hit = resolveRefLocator(page, snap, spec.ref);
      if (hit) {
        const n = await hit.locator.count().catch(() => 0);
        if (n === 1 && !(await refIdentitySuspect(hit, spec))) {
          return { locator: hit.locator, frame: hit.frame, strategy: "semantic_dom", attempted };
        }
        if (n > 1) {
          return { errorClass: "ambiguous_target", error: `ref ${spec.ref} resolved to ${n} elements`, attempted };
        }
        // n === 0: ref gone/detached → stale; n === 1 but the identity
        // check flagged the element as no longer matching the model's
        // intent (a re-render re-stamped the ref onto a DIFFERENT
        // control) — in BOTH cases fall through to expanded_dom so the
        // role+name recovery ladder runs and reports `recovered`.
      }
    }

    // 2) expanded_dom — fresh index, then either the same ref or a unique
    // semantic re-match (dynamic re-render recovery).
    attempted.push("expanded_dom");
    const fresh = await indexPage(page);
    const again = resolveRefLocator(page, fresh, spec.ref);
    if (again) {
      const n = await again.locator.count().catch(() => 0);
      // The same ref id in the FRESH index may now sit on a different
      // element after a re-render — trust it only when the semantic
      // identity is unchanged; otherwise fall through to role+name
      // recovery (never silently click the wrong control).
      const oldInfo = snap?.refs.find((r) => r.ref === again.ref);
      const newInfo = fresh.refs.find((r) => r.ref === again.ref);
      const sameIdentity =
        !oldInfo ||
        !newInfo ||
        (oldInfo.role === newInfo.role &&
          oldInfo.name.toLowerCase() === newInfo.name.toLowerCase());
      if (n === 1 && sameIdentity) {
        return { locator: again.locator, frame: again.frame, recovered: true, strategy: "expanded_dom", attempted };
      }
    }
    const rec = recoverRefInSnapshot(page, fresh, spec);
    if (rec) return { ...rec, recovered: true, strategy: "expanded_dom", attempted };
    const recN = fresh.refs.filter(
      (r) => spec.role && r.role === spec.role && spec.name && r.name.toLowerCase() === spec.name.toLowerCase(),
    ).length;
    if (recN > 1) {
      return { errorClass: "ambiguous_target", error: `${recN} elements match role+name`, attempted };
    }
  }

  // 3) typed selectors across every frame (selector / role+name / label / text).
  if (spec.selector || spec.role || spec.label || spec.text) {
    attempted.push(spec.ref || attempted.includes("expanded_dom") ? "frame_dom" : "semantic_dom");
    const cands = await resolveTargetLocators(page, spec);
    if (cands.length === 1) {
      return { locator: cands[0].locator, frame: cands[0].frame, attempted };
    }
    if (cands.length > 1) {
      return {
        errorClass: "ambiguous_target",
        error: `${cands.length} elements match — refine with a snapshot ref`,
        attempted,
      };
    }
  }

  // 4) canvas-only detection (no DOM targets anywhere).
  const snap = currentSnapshot();
  if ((!snap || snap.refs.length === 0) && (await hasCanvas(page))) {
    attempted.push("frame_dom");
    return { canvasOnly: true, errorClass: "canvas_only", error: "page has no DOM targets; canvas-driven UI", attempted };
  }

  return {
    errorClass: spec.ref ? "stale_ref" : "target_not_found",
    error: "no element matched the target",
    attempted,
  };
}
