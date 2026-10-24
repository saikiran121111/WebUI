/**
 * Server-side execution of the EXTENDED browser_api vocabulary.
 *
 * All policy lives HERE, not in prompts:
 *  - consequential actions (pay / send / post / delete / final submit)
 *    execute ONLY with a live server-side grant (taskState) — the fence
 *    flag `confirmConsequential` is advisory and never sufficient;
 *  - security challenges are detected after every action and immediately
 *    park the task (waiting_for_login / waiting_for_user_action) — the
 *    agent never automates around them;
 *  - resume never repeats a completed non-idempotent op;
 *  - form VALUES never reach the result payload, snapshots, or telemetry.
 *
 * The Page handle and navigation come from interactiveBrowser via ctx —
 * this module owns actions, interactiveBrowser owns the session.
 */
import type { Page } from "playwright";
import type { BrowserApiAction, BrowserTargetFields } from "./browserToolProtocol";
import { locateTarget } from "./browserTargeting";
import { indexPage, currentSnapshot, snapshotSummaryText } from "./domIndexer";
import { recordBrowserApiOutcome } from "./panelState";
import { showAiHighlight } from "./highlightOverlay";
import { runKeySequence } from "./keyboardFallback";
import {
  detectSecurityChallenge,
  challengeWaitingReason,
} from "./securityChallengeDetector";
import {
  classifyFailure,
  nextStrategy,
  type BrowserStrategy,
  type FailureClass,
} from "./fallbackController";
import {
  visionGroundAdapter,
  mockGroundFromPage,
  visionMockEnabled,
} from "./visualGrounding";
import {
  currentTask,
  startTask,
  updateTask,
  logStep,
  markNonIdempotentDone,
  hasDoneNonIdempotent,
  grantConsequentialAuthorization,
  consumeConsequentialGrant,
  requestConfirmation,
  type WaitingReason,
} from "./taskState";
import {
  recordBrowserMetric,
  incrementBrowserCounter,
  recordStrategyUse,
} from "./telemetry";
import type { BrowserEngine } from "./engineConfig";
import type { TaskState } from "./taskState";
import { isFixtureAllowed } from "@/lib/web-search/ssrf";

export interface ActionContext {
  engine: BrowserEngine;
  /** Session-owned navigation: SSRF/fixture guard. */
  goto: (url: string) => Promise<void>;
  /** ONE transient screenshot (data: URL) for visual grounding — a single
   *  capture of the user's visible window, NEVER a screencast/mirror. */
  screenshot: () => Promise<string | null>;
  /** Resolve the LIVE tab — popup adoption may swap the underlying page
   *  mid-action; the captured handle would then be a dead tab. */
  livePage?: () => Page | null;
}

/** Prefer the live tab when the session swapped it (popup adoption). */
function liveOr(page: Page, ctx: ActionContext): Page {
  return ctx.livePage?.() ?? page;
}

export interface ActionResult {
  ok: boolean;
  action: string;
  url: string;
  title: string;
  error?: string;
  errorClass?: FailureClass;
  snapshotId?: number;
  snapshotText?: string;
  challenge?: { kind: string; guidance: string };
  taskState?: TaskState;
  consentReason?: WaitingReason;
  needs_consent?: boolean;
  taskId?: string;
  recovered?: boolean;
  strategies?: BrowserStrategy[];
  fields?: { target: string; ok: boolean; error?: string }[];
  submitted?: boolean;
  completedSteps?: { action: string; ok: boolean; error?: string }[];
  pressed?: string[];
  skipped?: boolean;
  message?: string;
  handoff?: boolean;
  guidance?: string;
}

/** Consequential-action heuristic (target/button wording). Deliberately
 * conservative: a button literally named "Send …" gates even when harmless
 * ("send\b") — consent friction on an ambiguous verb is the safe side. */
const CONSEQUENTIAL_RE =
  /\b(pay\b|payment|purchase|buy now|checkout|place order|send\b|post\b|publish|delete|remove|transfer|submit application|apply now|sign (contract|agreement)|accept terms)\b/i;

/** Exported so unit tests can pin BOTH sides of the gate (what parks a
 * task and what must sail through). */
export function isConsequentialName(name: string): boolean {
  return CONSEQUENTIAL_RE.test(name);
}

/** Actions that can change the page (DOM re-render, navigation, form
 * state). After a successful one, the tail of executeBrowserAction
 * re-indexes so the model's NEXT fence sees fresh refs — the act→see→act
 * loop without a dedicated `snapshot` round-trip (one inference turn
 * saved per action). `navigate` already indexes in its own case; `screenshot`,
 * `read`, `snapshot`, `authorize_*` are read-only / non-DOM. */
const STATE_CHANGING_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "fill",
  "select",
  "check",
  "press",
  "keyboard_nav",
  "fill_form",
  "batch",
]);

function envLabel(page: Page): "local_fixture" | "mock" | "real_browser" {
  try {
    if (isFixtureAllowed(page.url())) return "local_fixture";
  } catch {
    /* not a fixture */
  }
  return "real_browser";
}

async function pageText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 2500));
  } catch {
    return "";
  }
}

/**
 * Wording of the page's own submit controls — the honest signal for
 * whether submitting a just-filled form is consequential. Whole-page BODY
 * text is NOT: an article or nav that merely mentions "post"/"send"/
 * "remove" used to false-positive the consent gate on every fill_form
 * with submitMode:"submit". Only fall back to page text when the page
 * exposes no button-family controls at all.
 */
async function submitControlWording(page: Page): Promise<string> {
  try {
    return await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('button, input[type="submit"], [role="button"]'),
      )
        .map((el) => {
          const e = el as HTMLElement;
          return [
            e.getAttribute("aria-label"),
            (e as HTMLInputElement).value,
            e.getAttribute("value"),
            e.textContent,
          ]
            .filter((t): t is string => !!t && t.trim() !== "")
            .join(" ");
        })
        .join(" | ")
        .replace(/\s+/g, " ")
        .slice(0, 2500),
    );
  } catch {
    return "";
  }
}

async function statusOf(page: Page): Promise<{ url: string; title: string }> {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

/** Post-action security-challenge probe — parks the task when present. */
async function probeChallenge(page: Page, base: ActionResult): Promise<void> {
  const st = await statusOf(page);
  const challenge = detectSecurityChallenge({
    url: st.url,
    title: st.title,
    text: await pageText(page),
  });
  if (!challenge) return;
  incrementBrowserCounter("challengesSeen");
  incrementBrowserCounter("humanHandoffs");
  base.challenge = { kind: challenge.kind, guidance: challenge.guidance };
  const waiting = challengeWaitingReason(challenge.kind);
  updateTask({ state: waiting, reason: undefined, url: st.url, title: st.title });
  base.taskState = waiting;
  base.handoff = true;
}

function targetDesc(t: BrowserTargetFields): string {
  return (
    t.ref ??
    (t.role ? `${t.role} "${t.name ?? ""}"` : undefined) ??
    t.label ??
    t.text ??
    t.selector ??
    "?"
  ).slice(0, 120);
}

/* ── visual grounding (single transient screenshot, local vision) ──────── */

async function tryVisualClick(
  page: Page,
  ctx: ActionContext,
  goal: string,
  base: ActionResult,
): Promise<boolean> {
  if (!goal || ctx.engine === "firefox" && !ctx.screenshot && !visionMockEnabled()) return false;
  if (!ctx.screenshot && !visionMockEnabled()) return false;
  recordStrategyUse("visual_grounding");
  // Record the attempt BEFORE the outcome so a refusal error below is not
  // overwritten by doClick's DOM "target not found" fallback.
  base.strategies = [...(base.strategies ?? []), "visual_grounding"];
  try {
    let grounded;
    if (visionMockEnabled()) {
      grounded = await mockGroundFromPage(page);
    } else {
      const shot = await ctx.screenshot!();
      if (!shot) return false;
      incrementBrowserCounter("screenshotsTaken");
      const m = shot.match(/data:image\/(?:jpeg|png);base64,/);
      const dims = await page
        .evaluate(() => [window.innerWidth, window.innerHeight])
        .catch(() => [1280, 800]);
      grounded = await visionGroundAdapter(shot, goal, dims[0], dims[1]);
    }
    if (!grounded.ok || !grounded.target) {
      base.error = `visual grounding refused: ${grounded.error ?? "ambiguous"}`;
      return false;
    }
    const t = grounded.target;
    await showAiHighlight(page, "click", { x: t.x, y: t.y, width: t.width, height: t.height });
    await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
    base.message = `clicked visually-located target "${grounded.label}" (confidence ${grounded.confidence})`;
    return true;
  } catch (e) {
    base.error = `visual grounding failed: ${String(e).slice(0, 120)}`;
    return false;
  }
}

/* ── click with full ladder ─────────────────────────────────────────────── */

async function doClick(
  page: Page,
  a: BrowserApiAction,
  ctx: ActionContext,
  base: ActionResult,
): Promise<void> {
  const before = await statusOf(page);
  const located = await locateTarget(page, a);
  base.strategies = located.attempted;
  if (located.locator) {
    const name = (await located.locator.getAttribute("aria-label").catch(() => null))
      ?? (await located.locator.innerText().catch(() => "")).slice(0, 80);
    const sig = `click:${before.url}:${(a.ref ?? name).slice(0, 100)}`;
    if (CONSEQUENTIAL_RE.test(name) || (a.confirmConsequential && hasDoneNonIdempotent(sig))) {
      if (hasDoneNonIdempotent(sig)) {
        base.skipped = true;
        base.message = "already completed earlier in this task — skipped on resume (no double-submit)";
        return;
      }
    }
    if (CONSEQUENTIAL_RE.test(name)) {
      if (!consumeConsequentialGrant()) {
        incrementBrowserCounter("consequentialBlocked");
        requestConfirmation("consequential_action_consent");
        base.ok = false;
        base.needs_consent = true;
        base.consentReason = "consequential_action_consent";
        base.taskId = currentTask()?.id;
        base.error = "consequential action requires your authorization — ask the user to confirm, then send authorize_browser_access";
        base.taskState = "waiting_for_confirmation";
        base.guidance = `About to "${name.trim().slice(0, 60)}" — get explicit user consent, then re-run with authorize_browser_access first.`;
        return;
      }
      incrementBrowserCounter("consequentialGranted");
    }
    const box = await located.locator.boundingBox().catch(() => null);
    if (box) await showAiHighlight(page, "click", box);
    await located.locator.click({ timeout: 8000 });
    if (CONSEQUENTIAL_RE.test(name)) markNonIdempotentDone(sig);
    base.recovered = located.recovered;
    base.strategies = [...located.attempted, located.strategy ?? "semantic_dom"];
  } else {
    // Ladder escalation for the failed DOM locate.
    const failure = located.canvasOnly ? "canvas_only" : located.errorClass ?? "target_not_found";
    let decision = nextStrategy(failure as FailureClass, located.attempted);
    let visualHit = false;
    if (decision.strategy === "visual_grounding") {
      const goal = a.name || a.label || a.text || "";
      visualHit = await tryVisualClick(page, ctx, goal, base);
      if (!visualHit) {
        decision = nextStrategy(failure as FailureClass, [...located.attempted, "visual_grounding"]);
      }
    }
    // A REFUSED/failed visual attempt is still a failure — an attempted
    // strategy must never leave ok:true with an error string attached.
    if (!visualHit) {
      base.ok = false;
      base.error = base.error ?? located.error ?? "target not found";
      base.errorClass = failure as FailureClass;
    }
    if (decision.handoff) {
      incrementBrowserCounter("humanHandoffs");
      recordStrategyUse("human_handoff");
      updateTask({ state: decision.waitingFor ?? "waiting_for_user_action" });
      base.handoff = true;
      base.taskState = decision.waitingFor ?? "waiting_for_user_action";
      base.guidance =
        "I could not drive this control automatically. Do it directly in the browser window and tell me when done (I will verify and continue), or describe the element more precisely.";
    }
  }
  await probeChallenge(page, base);
  const after = await statusOf(page);
  base.url = after.url;
  base.title = after.title;
  if (after.url !== before.url) base.message = (base.message ? base.message + " | " : "") + `navigated → ${after.url}`;
  logStep("click", base.ok);
}

/* ── fill / select / check / hover / press ─────────────────────────────── */

async function withLocator(
  page: Page,
  a: BrowserApiAction,
  base: ActionResult,
  kind: "fill" | "select" | "check" | "hover" | "press",
): Promise<void> {
  const located = await locateTarget(page, a);
  base.strategies = located.attempted;
  if (!located.locator) {
    base.ok = false;
    base.error = located.error ?? "target not found";
    base.errorClass = located.errorClass ?? "target_not_found";
    return;
  }
  const box = await located.locator.boundingBox().catch(() => null);
  if (box) await showAiHighlight(page, kind === "fill" ? "fill" : "focus", box);
  try {
    if (kind === "fill") {
      const val = String(a.value ?? a.text ?? "");
      await located.locator.fill(val, { timeout: 8000 });
      base.message = `filled ${targetDesc(a)}`;
    } else if (kind === "select") {
      await located.locator.selectOption(String(a.value ?? ""), { timeout: 8000 });
      base.message = `selected in ${targetDesc(a)}`;
    } else if (kind === "check") {
      if (a.checked === false) await located.locator.uncheck({ timeout: 8000 });
      else await located.locator.check({ timeout: 8000 });
      base.message = `${a.checked === false ? "unchecked" : "checked"} ${targetDesc(a)}`;
    } else if (kind === "hover") {
      await located.locator.hover({ timeout: 8000 });
      base.message = `hovered ${targetDesc(a)}`;
    } else {
      const key = String(a.text ?? a.keys?.[0] ?? "Enter");
      await located.locator.press(key, { timeout: 8000 });
      base.message = `pressed ${key} in ${targetDesc(a)}`;
    }
    if (kind === "fill" || kind === "check") markNonIdempotentDone(`${kind}:${page.url()}:${targetDesc(a)}`);
    logStep(kind, true);
  } catch (e) {
    base.ok = false;
    base.error = String(e).slice(0, 200);
    base.errorClass = classifyFailure(String(e));
    logStep(kind, false);
  }
  await probeChallenge(page, base);
}

/* ── fill_form (per-field results; submit gated server-side) ───────────── */

async function doFillForm(
  page: Page,
  a: BrowserApiAction,
  base: ActionResult,
): Promise<void> {
  const fields = a.fields ?? [];
  if (fields.length === 0) {
    base.ok = false;
    base.error = "fill_form requires fields[]";
    return;
  }
  base.fields = [];
  let lastField: (typeof fields)[number] | null = null;
  for (const f of fields) {
    const located = await locateTarget(page, f);
    if (!located.locator) {
      base.fields.push({ target: targetDesc(f), ok: false, error: located.error ?? "not found" });
      continue;
    }
    const box = await located.locator.boundingBox().catch(() => null);
    if (box) await showAiHighlight(page, "fill", box);
    try {
      if (f.checked !== undefined) {
        if (f.checked) await located.locator.check({ timeout: 6000 });
        else await located.locator.uncheck({ timeout: 6000 });
      } else if (f.role === "combobox") {
        const value = String(f.value ?? "");
        const isNativeSelect = await located.locator
          .evaluate((el) => el.tagName === "SELECT")
          .catch(() => false);
        if (isNativeSelect) {
          await located.locator.selectOption(value, { timeout: 6000 });
        } else {
          // Custom ARIA combobox (Radix / Shadcn / React-Select …):
          // selectOption THROWS on these — drive it like a human:
          // type into the entry, or open the popup and pick the option.
          const isTextEntry = await located.locator
            .evaluate(
              (el) =>
                el instanceof HTMLInputElement ||
                el instanceof HTMLTextAreaElement ||
                (el as HTMLElement).isContentEditable,
            )
            .catch(() => false);
          if (isTextEntry) {
            await located.locator.fill(value, { timeout: 6000 });
          } else {
            await located.locator.click({ timeout: 6000 }); // open the listbox
            const scope = located.frame ?? page;
            const opt =
              value &&
              scope.locator('[role="option"]').filter({ hasText: value }).first();
            if (opt && (await opt.count().catch(() => 0)) > 0) {
              await opt.click({ timeout: 6000 });
            } else {
              const item = value
                ? scope.getByText(value, { exact: false }).first()
                : null;
              if (item && (await item.count().catch(() => 0)) > 0) {
                await item.click({ timeout: 6000 });
              } else {
                // Nothing matched — close the popup and fail HONESTLY
                // for this field instead of leaving a stray menu open.
                await located.locator.press("Escape").catch(() => {});
                throw new Error(
                  `combobox option "${value.slice(0, 60)}" not found after opening the popup`,
                );
              }
            }
          }
        }
      } else {
        await located.locator.fill(String(f.value ?? ""), { timeout: 6000 });
      }
      lastField = f;
      base.fields.push({ target: targetDesc(f), ok: true });
    } catch (e) {
      base.fields.push({ target: targetDesc(f), ok: false, error: String(e).slice(0, 140) });
    }
  }
  const failed = base.fields.filter((f) => !f.ok).length;
  base.ok = failed === 0;

  if (a.submitMode === "submit" && base.ok) {
    // Is the submit consequential? Probe the FORM'S OWN submit controls
    // (button labels/values); only pages with no button-family controls
    // fall back to body text — body copy mentioning "post/send/remove"
    // is not a submit signal.
    const submitWording =
      (await submitControlWording(page)) || (await pageText(page)).slice(0, 2500);
    const sig = `fill_form_submit:${page.url()}`;
    if (CONSEQUENTIAL_RE.test(submitWording) || (a.confirmConsequential === true)) {
      if (hasDoneNonIdempotent(sig)) {
        base.skipped = true;
        base.message = "submit already completed earlier — skipped (resume safety: never re-submits)";
        return;
      }
      if (!consumeConsequentialGrant()) {
        incrementBrowserCounter("consequentialBlocked");
        requestConfirmation("consequential_action_consent");
        base.ok = false;
        base.needs_consent = true;
        base.consentReason = "consequential_action_consent";
        base.taskId = currentTask()?.id;
        base.submitted = false;
        base.error =
          "fields prepared, but submitting is consequential and needs explicit user authorization (send authorize_browser_access after the user confirms).";
        base.taskState = "waiting_for_confirmation";
        return;
      }
      incrementBrowserCounter("consequentialGranted");
    }
    try {
      if (lastField) {
        const loc = await locateTarget(page, lastField);
        await loc.locator?.press("Enter", { timeout: 6000 });
      } else {
        await page.keyboard.press("Enter");
      }
      markNonIdempotentDone(sig);
      base.submitted = true;
    } catch (e) {
      base.ok = false;
      base.error = `submit failed: ${String(e).slice(0, 160)}`;
    }
  } else if (base.ok) {
    base.submitted = false;
    base.message =
      "fields filled (submit NOT performed — send submitMode:\"submit\" only after user review)";
  }
  logStep("fill_form", base.ok);
  await probeChallenge(page, base);
}

/* ── batch (sequential, stop-on-failure, no blind retry) ───────────────── */

async function doBatch(
  page: Page,
  a: BrowserApiAction,
  ctx: ActionContext,
  base: ActionResult,
): Promise<void> {
  const steps = a.steps ?? [];
  if (steps.length === 0) {
    base.ok = false;
    base.error = "batch requires steps[]";
    return;
  }
  base.completedSteps = [];
  for (const s of steps) {
    // Each step executes EXACTLY once; first failure stops the batch.
    // A mid-batch navigate can swap the tab — resolve it per step.
    const stepPage = liveOr(page, ctx);
    const sub = await executeBrowserAction(stepPage, { ...s, action: s.action as BrowserApiAction["action"] }, ctx, true);
    base.completedSteps.push({
      action: s.action,
      ok: sub.ok,
      ...(sub.error ? { error: sub.error.slice(0, 140) } : {}),
    });
    if (!sub.ok || sub.needs_consent || sub.handoff) {
      base.ok = false;
      base.error = `stopped at step "${s.action}": ${(sub.error ?? "handoff/pause").slice(0, 160)}`;
      base.needs_consent = sub.needs_consent;
      base.consentReason = sub.consentReason;
      base.handoff = sub.handoff;
      break;
    }
  }
  base.strategies = (base.completedSteps ?? []).map((s) => s.action as unknown as BrowserStrategy);
}

/* ── resume_task (safe resumption after human action / waiting state) ──── */

async function doResume(
  page: Page,
  base: ActionResult,
): Promise<void> {
  const task = currentTask();
  if (!task) {
    base.ok = false;
    base.error = "no active browser task to resume";
    return;
  }
  await probeChallenge(page, base);
  if (base.challenge) {
    base.ok = false;
    base.error = `still waiting: ${base.challenge.kind}`;
    base.guidance = base.challenge.guidance;
    return;
  }
  const snap = await indexPage(page);
  updateTask({ state: "running", reason: undefined, snapshotId: snap.snapshotId, url: page.url(), title: snap.title });
  base.ok = true;
  base.taskState = "running";
  base.snapshotId = snap.snapshotId;
  base.snapshotText = snapshotSummaryText(snap);
  base.message =
    `resumed task ${task.id}; already-completed non-idempotent steps will NOT be repeated: ` +
    (task.completedNonIdempotent.length ? task.completedNonIdempotent.join(" ; ") : "(none)");
  logStep("resume_task", true);
}

/* ── main dispatch ─────────────────────────────────────────────────────── */

export async function executeBrowserAction(
  page: Page,
  a: BrowserApiAction,
  ctx: ActionContext,
  nested = false,
): Promise<ActionResult> {
  const st = await statusOf(page);
  const base: ActionResult = { ok: true, action: a.action, url: st.url, title: st.title };
  const t0 = Date.now();
  try {
    if (!currentTask() && !nested && a.action !== "resume_task") {
      startTask(a.url ?? st.title ?? st.url, ctx.engine);
    }
    switch (a.action) {
      case "snapshot": {
        incrementBrowserCounter("snapshotsTaken");
        const snap = await indexPage(page);
        base.snapshotId = snap.snapshotId;
        base.snapshotText = snapshotSummaryText(snap);
        await probeChallenge(page, base);
        updateTask({ snapshotId: snap.snapshotId, url: snap.url, title: snap.title });
        logStep("snapshot", true);
        break;
      }
      case "click":
        await doClick(page, a, ctx, base);
        break;
      case "fill":
        await withLocator(page, a, base, "fill");
        break;
      case "select":
        await withLocator(page, a, base, "select");
        break;
      case "check":
        await withLocator(page, a, base, "check");
        break;
      case "hover":
        await withLocator(page, a, base, "hover");
        break;
      case "press":
        await withLocator(page, a, base, "press");
        break;
      case "keyboard_nav": {
        const r = await runKeySequence(page, a.keys ?? []);
        base.ok = r.ok;
        base.pressed = r.pressed;
        if (r.error) base.error = r.error;
        if (!r.ok) base.errorClass = classifyFailure(r.error ?? "");
        recordStrategyUse("keyboard");
        logStep("keyboard_nav", r.ok);
        await probeChallenge(page, base);
        break;
      }
      case "fill_form":
        await doFillForm(page, a, base);
        break;
      case "batch":
        await doBatch(page, a, ctx, base);
        break;
      case "resume_task":
        await doResume(page, base);
        break;
      case "authorize_browser_access": {
        grantConsequentialAuthorization();
        incrementBrowserCounter("consequentialGranted");
        base.message =
          "authorization recorded server-side (10 min, single-use per consequential op). You may now attempt the authorized action once.";
        updateTask({ state: "running", reason: undefined });
        logStep("authorize_browser_access", true);
        break;
      }
      case "navigate": {
        const target = a.url ?? "";
        if (!target) {
          base.ok = false;
          base.error = "navigate requires url";
          break;
        }
        const before = await statusOf(page);
        await ctx.goto(target);
        // Popup adoption may have swapped the tab — read the NEW one.
        const live = liveOr(page, ctx);
        base.url = live.url();
        base.title = await live.title().catch(() => "");
        base.message = `${before.url} → ${base.url}`;
        await probeChallenge(live, base);
        const snap = await indexPage(live);
        base.snapshotId = snap.snapshotId;
        base.snapshotText = snapshotSummaryText(snap);
        logStep("navigate", true);
        break;
      }
      default:
        base.ok = false;
        base.error = `unsupported action in semantic executor: ${a.action}`;
    }
  } catch (e) {
    base.ok = false;
    base.error = String(e).slice(0, 300);
    base.errorClass = classifyFailure(base.error);
  }
  // Fresh refs for the model's next fence: any state-changing success
  // re-indexes the live page and piggybacks the new ref map onto the
  // result. Deliberately NOT counted as `snapshotsTaken` telemetry —
  // that counter tracks explicit snapshot actions; and nested batch
  // steps skip this (the outer batch result indexes once at the end).
  if (!nested && base.ok && STATE_CHANGING_ACTIONS.has(a.action)) {
    try {
      const refreshed = await indexPage(liveOr(page, ctx));
      base.snapshotId = refreshed.snapshotId;
      base.snapshotText = snapshotSummaryText(refreshed);
    } catch {
      /* page navigating — the next explicit snapshot catches up */
    }
  }
  if (!nested) {
    recordBrowserMetric(`action:${a.action}`, Date.now() - t0, base.ok, envLabel(page));
    // Server-side act→see→act write: /api/chat reads this globalThis
    // slot next turn (authContext.ts). Recorded here — not just in the
    // client component — so the outcome survives across route bundles
    // and reloads of the fence block.
    recordBrowserApiOutcome({
      action: a.action,
      ...(a.url ? { url: a.url } : {}),
      ...(a.text ? { text: String(a.text).slice(0, 120) } : {}),
      ok: base.ok,
      ...(base.error ? { error: base.error } : {}),
    });
  }
  return base;
}
