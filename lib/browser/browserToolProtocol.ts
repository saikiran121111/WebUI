/**
 * The model-facing protocol for driving the browser agent.
 *
 * The main LLM CANNOT fetch — it can only emit text. So browser control
 * travels as a fenced block inside the assistant reply:
 *
 *   ```browser_api
 *   {"action":"click","ref":"e14"}
 *   ```
 *
 * The UI executes the fence server-side (components/render/
 * BrowserApiBlock.tsx POSTs it verbatim to /api/browser), renders a
 * result chip, and the NEXT turn's system context carries what the
 * browser tab shows (lib/browser/panelState.ts + live tab info from
 * lib/browser/interactiveBrowser.ts → authContext) — the model's
 * on-the-fly loop: act, see, act again. No native tool calling; an
 * older client just shows the fence as a code block.
 *
 * SEMANTIC VOCABULARY ONLY: targets are ref / selector / role+name /
 * label / visible text — never raw coordinates. The session drives the
 * user's own OS browser; geometry actions, panel playback and media
 * embeds no longer exist anywhere in the product.
 */

/** The exact fence language the model emits. */
export const BROWSER_FENCE_LANG = "browser_api";

export type BrowserApiActionName =
  | "navigate"
  | "click"
  | "snapshot"
  | "fill"
  | "select"
  | "check"
  | "hover"
  | "press"
  | "keyboard_nav"
  | "fill_form"
  | "batch"
  | "resume_task"
  | "authorize_browser_access";

/** Semantic target selectors — exactly one primary target per action. */
export interface BrowserTargetFields {
  /** Ref id from the newest snapshot ("e12" or frame-qualified "f1:e4"). */
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  label?: string;
  /** Visible-text target (weak-DOM pages). The executor also accepts it
   *  as fill/press content via the value/keys aliases. */
  text?: string;
  /** Which snapshot a ref came from (defaults to the newest). */
  snapshotId?: number;
}

export interface BrowserFormField extends BrowserTargetFields {
  /** Text/combo value. Password values pass through transiently — they are
   *  NEVER stored in snapshots, task state, logs, or telemetry. */
  value?: string;
  checked?: boolean;
}

export type BatchStep = Pick<
  BrowserApiAction,
  | "action"
  | "url"
  | "text"
  | "ref"
  | "selector"
  | "role"
  | "name"
  | "label"
  | "value"
  | "keys"
  | "checked"
>;

/** One browser action, as the model writes it inside the fence. */
export interface BrowserApiAction extends BrowserTargetFields {
  action: BrowserApiActionName;
  /** Destination for navigate. */
  url?: string;
  /** Value for fill/select (top-level convenience alias). */
  value?: string;
  /** Key sequence for keyboard_nav / press. */
  keys?: string[];
  /** Desired checked state for `check` (defaults to toggling toward checked). */
  checked?: boolean;
  /** Form fields for fill_form (bounded). */
  fields?: BrowserFormField[];
  /** "prepare_only" (default) fills but never submits; "submit" requires a
   *  live server-side authorization grant for consequential forms. */
  submitMode?: "prepare_only" | "submit";
  /** Ordered sub-actions for batch (no nested batch, no resume/authorize). */
  steps?: BatchStep[];
  /** Advisory only — the SERVER enforces consequential gating via its own
   *  grant state; a client-side true is never sufficient. */
  confirmConsequential?: boolean;
}

const MAX_FENCE_BYTES = 16_000;
const MAX_FIELDS = 32;
const MAX_STEPS = 8;
const MAX_KEYS = 40;

export const VALID_ACTIONS: readonly string[] = [
  "navigate", "click", "snapshot", "fill", "select", "check", "hover",
  "press", "keyboard_nav", "fill_form", "batch", "resume_task",
  "authorize_browser_access",
];

/** Actions embeddable inside a batch step (no recursion, no self-granting). */
export const BATCHABLE: readonly string[] = [
  "navigate", "click", "snapshot", "fill", "select", "check", "hover",
  "press", "keyboard_nav", "fill_form",
];

const str = (v: unknown, cap: number): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, cap) : undefined;

const targetFields = (p: Record<string, unknown>): Partial<BrowserTargetFields> => {
  const t: Partial<BrowserTargetFields> = {};
  const ref = str(p.ref, 40);
  if (ref) t.ref = ref;
  const selector = str(p.selector, 500);
  if (selector) t.selector = selector;
  const role = str(p.role, 40);
  if (role) t.role = role;
  const name = str(p.name, 200);
  if (name) t.name = name;
  const label = str(p.label, 200);
  if (label) t.label = label;
  const text = str(p.text, 200);
  if (text !== undefined) t.text = text;
  if (typeof p.snapshotId === "number" && Number.isInteger(p.snapshotId) && p.snapshotId > 0) {
    t.snapshotId = p.snapshotId;
  }
  return t;
};

const keysList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 20)
    .slice(0, MAX_KEYS);
  return out.length ? out : undefined;
};

const formFields = (v: unknown): BrowserFormField[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: BrowserFormField[] = [];
  for (const f of v.slice(0, MAX_FIELDS)) {
    if (!f || typeof f !== "object") continue;
    const p = f as Record<string, unknown>;
    // Field `text` is a semantic target (visible label text), so the
    // target-fields pass handles it — no special cases left to undo.
    const ff: BrowserFormField = { ...(targetFields(p) as BrowserFormField) };
    const value = str(p.value, 1000);
    if (value !== undefined) ff.value = value;
    if (typeof p.checked === "boolean") ff.checked = p.checked;
    out.push(ff);
  }
  return out.length ? out : undefined;
};

const batchSteps = (v: unknown): BatchStep[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: BatchStep[] = [];
  for (const s of v.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== "object") continue;
    const p = s as Record<string, unknown>;
    const action = p.action;
    if (typeof action !== "string" || !BATCHABLE.includes(action)) continue;
    const step: BatchStep = { action } as BatchStep;
    const url = str(p.url, 2048);
    if (url) step.url = url;
    Object.assign(step, targetFields(p));
    const value = str(p.value, 1000);
    if (value !== undefined) step.value = value;
    const keys = keysList(p.keys);
    if (keys) step.keys = keys;
    if (typeof p.checked === "boolean") step.checked = p.checked;
    out.push(step);
  }
  return out.length ? out : undefined;
};

/**
 * Parse the LAST complete ```browser_api fence in an assistant reply.
 * Mid-stream, the fence may be partial — only the newest CLOSED fence is
 * ever executed. Returns null when there is no complete, valid fence.
 */
export function extractBrowserApiFence(
  content: string,
): BrowserApiAction | null {
  const re = /```browser_api\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: BrowserApiAction | null = null;
  while ((m = re.exec(content))) {
    const body = m[1];
    if (body.length > MAX_FENCE_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // partial / malformed fence — never execute garbage
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const p = parsed as Record<string, unknown>;
    const action = p.action;
    if (typeof action !== "string" || !VALID_ACTIONS.includes(action)) continue;
    const out: BrowserApiAction = {
      action: action as BrowserApiActionName,
      ...targetFields(p),
    };
    const url = str(p.url, 2048);
    if (url) out.url = url;
    const value = str(p.value, 1000);
    if (value !== undefined) out.value = value;
    const keys = keysList(p.keys);
    if (keys) out.keys = keys;
    if (typeof p.checked === "boolean") out.checked = p.checked;
    const fields = formFields(p.fields);
    if (fields) out.fields = fields;
    if (p.submitMode === "prepare_only" || p.submitMode === "submit") out.submitMode = p.submitMode;
    const steps = batchSteps(p.steps);
    if (steps) out.steps = steps;
    if (typeof p.confirmConsequential === "boolean") out.confirmConsequential = p.confirmConsequential;
    last = out;
  }
  return last;
}
