/**
 * Semantic DOM indexing — the agent's "eyes" for acting on ANY website.
 *
 * indexPage(page) walks every frame (open shadow roots included), finds
 * interactive elements, computes a semantic role + accessible name for
 * each, stamps a stable ref attribute (`data-ai-ref="e12"`, frame-
 * qualified `f1:e12`), and returns a bounded snapshot the model can act
 * on. This is deliberately generic: no site-specific selectors anywhere.
 *
 * SECURITY: password-family input values are NEVER captured — the type
 * itself ("password", "current-password", …) is recorded but the value is
 * masked. Values are capped and only short non-secret ones included.
 */
import type { Frame, Locator, Page } from "playwright";

export interface RefInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  /** Present when the element is a checkbox/radio — lets `check` decide. */
  checked?: boolean;
  /** Present for password-family inputs — the VALUE is never stored. */
  valueMask?: "•••";
  frameIdx: number;
}

export interface PageSnapshot {
  snapshotId: number;
  url: string;
  title: string;
  refs: RefInfo[];
  frameUrls: string[];
  truncated: boolean;
  snapshotAt: number;
}

const MAX_REFS = 150;
const MAX_SUMMARY_CHARS = 3500;
const STORE_CAP = 8;

const SCANNER_SELECTOR =
  'a,button,input,textarea,select,[role],[onclick],[contenteditable="true"],[tabindex]';

/** In-page scanner — serialized into the page; must stay self-contained.
 *  Playwright passes exactly ONE argument, so inputs travel as a tuple. */
type ScanArgs = [selector: string, prefix: string, max: number];

function scanRefs(args: ScanArgs) {
  const [selector, prefix, max] = args;
  const PASSWORD_TYPES = [
    "password", "current-password", "new-password", "one-time-code",
  ];
  const out: {
    ref: string; role: string; name: string; tag: string;
    checked?: boolean; valueMask?: "•••";
  }[] = [];
  const seen = new Set<Element>();

  const visible = (el: Element): boolean => {
    const e = el as HTMLElement;
    if (e.tagName === "AREA" || e.tagName === "OPTION" || e.tagName === "OPTGROUP") return true;
    if (e.tagName === "INPUT" && (e as HTMLInputElement).type === "hidden") return false;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    const cs = getComputedStyle(e);
    return cs.position === "fixed" || cs.position === "sticky";
  };

  const cap = (t: string): string => {
    const c = t.replace(/\s+/g, " ").trim();
    return c.length > 80 ? c.slice(0, 80) + "…" : c;
  };

  const labelFor = (el: Element): string => {
    const e = el as HTMLElement;
    const aria = e.getAttribute("aria-label") || "";
    if (aria.trim()) return cap(aria);
    const labelled = e.getAttribute("aria-labelledby");
    if (labelled) {
      const parts = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (parts.trim()) return cap(parts);
    }
    const alt = e.getAttribute("alt") || "";
    if (alt.trim()) return cap(alt);
    const ph = e.getAttribute("placeholder") || "";
    if (ph.trim()) return cap(ph);
    if (e.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      if (lab?.textContent?.trim()) return cap(lab.textContent);
      const wrap = e.closest("label");
      if (wrap?.textContent?.trim()) return cap(wrap.textContent);
    }
    const title = e.getAttribute("title") || "";
    if (title.trim()) return cap(title);
    const btnVal =
      e.tagName === "INPUT" &&
      ["submit", "button", "reset"].includes((e as HTMLInputElement).type)
        ? (e as HTMLInputElement).value
        : "";
    if (btnVal.trim()) return cap(btnVal);
    return cap(e.textContent || "");
  };

  const roleOf = (el: Element): string => {
    const e = el as HTMLElement;
    const r = e.getAttribute("role");
    if (r) return r;
    const tag = e.tagName;
    if (tag === "A") return e.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "INPUT") {
      const t = (e as HTMLInputElement).type;
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      return "textbox";
    }
    if (e.isContentEditable) return "textbox";
    if (e.hasAttribute("onclick") || e.getAttribute("tabindex") === "0") return "button";
    return "generic";
  };

  // Seed past any ref already stamped in THIS frame so a re-render can
  // never re-bind an old ref id onto a DIFFERENT element — stale refs must
  // fail honestly and fall to the recovery ladder, not silently retarget.
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refRe = new RegExp("^" + esc + "e(\\d+)$");
  let counter = 1;
  for (const el of document.querySelectorAll("[data-ai-ref]")) {
    const m = refRe.exec(el.getAttribute("data-ai-ref") ?? "");
    if (m) counter = Math.max(counter, parseInt(m[1], 10) + 1);
  }
  const walk = (root: Document | ShadowRoot) => {
    let els: NodeListOf<Element>;
    try {
      els = root.querySelectorAll(selector);
    } catch {
      return;
    }
    for (const el of els) {
      if (out.length >= max) return;
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest("[data-ai-skip]")) continue;
      const role = roleOf(el);
      // A bare [role]/[tabindex] div with no accessible name at all is noise.
      if (role === "generic" && !labelFor(el)) continue;
      if (!visible(el)) continue;
      const e = el as HTMLElement;
      let ref = e.getAttribute("data-ai-ref");
      if (!ref || !ref.startsWith(prefix)) {
        ref = prefix + "e" + counter++;
        e.setAttribute("data-ai-ref", ref);
      }
      const info: (typeof out)[number] = {
        ref,
        role,
        name: labelFor(el),
        tag: e.tagName.toLowerCase(),
      };
      if (e.tagName === "INPUT") {
        const inp = e as HTMLInputElement;
        if (
          PASSWORD_TYPES.includes(inp.type) ||
          PASSWORD_TYPES.includes(inp.getAttribute("autocomplete") || "")
        ) {
          info.valueMask = "•••";
        } else if (inp.type === "checkbox" || inp.type === "radio") {
          info.checked = inp.checked;
        }
      }
      out.push(info);
    }
    // Recurse into OPEN shadow roots (closed ones are unreachable — the
    // fallback ladder handles that honestly, never fabricating success).
    for (const el of root.querySelectorAll("*")) {
      if (out.length >= max) return;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };

  walk(document);
  return out;
}

/* ── snapshot store ─────────────────────────────────────────────────────── */

/**
 * The snapshot store lives on `globalThis` — NOT module scope. In Next.js
 * dev mode `/api/browser` and `/api/chat` are separate route bundles in
 * the same Node process; module-local Maps would each get a private
 * (empty) copy, so refs handed to the model by an action could never be
 * resolved on the chat side (and vice versa). One process-wide slot
 * keeps the live PageSnapshot map shared by every bundle.
 */
const DOM_STORE_GLOBAL = "__ruke_dom_snapshot_store__";
interface DomStore {
  snapshots: Map<number, PageSnapshot>;
  nextId: number;
  latestId: number;
}

const G: DomStore = (
  globalThis as typeof globalThis & { [DOM_STORE_GLOBAL]?: DomStore }
)[DOM_STORE_GLOBAL] ??= { snapshots: new Map(), nextId: 1, latestId: 0 };

function remember(s: PageSnapshot): void {
  G.snapshots.set(s.snapshotId, s);
  G.latestId = s.snapshotId;
  while (G.snapshots.size > STORE_CAP) {
    const oldest = G.snapshots.keys().next().value;
    if (oldest === undefined) break;
    G.snapshots.delete(oldest);
  }
}

export function getSnapshot(id: number): PageSnapshot | undefined {
  return G.snapshots.get(id);
}

export function currentSnapshot(): PageSnapshot | undefined {
  return G.snapshots.get(G.latestId);
}

/** Bounded human/model-readable ref map (the act→see→act feedback). */
export function snapshotSummaryText(s: PageSnapshot): string {
  const lines = s.refs.map((r) => {
    const checked = r.checked === undefined ? "" : r.checked ? " [checked]" : " [unchecked]";
    const mask = r.valueMask ? " [password field — value hidden]" : "";
    return `[${r.ref}] ${r.role} "${r.name}"${checked}${mask}`;
  });
  let text = "";
  let used = 0;
  for (const l of lines) {
    if (used + l.length > MAX_SUMMARY_CHARS) {
      text += "\n… (truncated)";
      break;
    }
    text += (text ? "\n" : "") + l;
    used += l.length;
  }
  if (s.truncated) text += `\n(${s.refs.length} refs; DOM truncated at ${MAX_REFS})`;
  return text || "(no interactive elements found)";
}

/** Index every frame of the page; stamps refs; returns the snapshot. */
export async function indexPage(page: Page): Promise<PageSnapshot> {
  const frames = page.frames();
  const refs: RefInfo[] = [];
  const frameUrls: string[] = [];
  let truncated = false;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    frameUrls.push(frame.url());
    if (refs.length >= MAX_REFS) {
      truncated = true;
      continue;
    }
    const prefix = i === 0 ? "" : `f${i}:`;
    let found: Awaited<ReturnType<typeof scanRefs>> = [];
    try {
      // Playwright's generic order is <R, Arg>.
      found = await frame.evaluate<Awaited<ReturnType<typeof scanRefs>>, ScanArgs>(
        scanRefs,
        [SCANNER_SELECTOR, prefix, MAX_REFS - refs.length + 1],
      );
    } catch {
      // frame navigated/closed mid-scan, or a cross-process frame —
      // honest partial coverage, never a fabricated success.
      if (frames.length > 1) truncated = true;
      continue;
    }
    for (const f of found) {
      if (refs.length >= MAX_REFS) {
        truncated = true;
        break;
      }
      refs.push({ ...f, frameIdx: i });
    }
  }

  const snapshot: PageSnapshot = {
    snapshotId: G.nextId++,
    url: page.url(),
    title: (await page.title().catch(() => "")) || "",
    refs,
    frameUrls,
    truncated,
    snapshotAt: Date.now(),
  };
  remember(snapshot);
  return snapshot;
}

/* ── ref → live locator resolution (with stale-ref recovery) ───────────── */

function frameForSnapshot(page: Page, s: PageSnapshot, frameIdx: number): Frame | null {
  const frames = page.frames();
  if (frameIdx < frames.length && frames[frameIdx].url() === s.frameUrls[frameIdx]) {
    return frames[frameIdx];
  }
  // Frame identity may have shifted — match by url, else fall back to index.
  const byUrl = frames.find((f) => f.url() === s.frameUrls[frameIdx]);
  return byUrl ?? frames[frameIdx] ?? null;
}

export interface ResolvedTarget {
  locator: Locator;
  frame: Frame;
  ref?: string;
}

/** Resolve a stamped ref (or bare e12) to a Playwright Locator. */
export function resolveRefLocator(
  page: Page,
  s: PageSnapshot,
  ref: string,
): ResolvedTarget | null {
  const info = s.refs.find((r) => r.ref === ref || r.ref === "e" + ref || ("e" + ref) === r.ref);
  if (!info) return null;
  const frame = frameForSnapshot(page, s, info.frameIdx);
  if (!frame) return null;
  return { locator: frame.locator(`[data-ai-ref="${info.ref}"]`).first(), frame, ref: info.ref };
}

export interface TargetSpec {
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  snapshotId?: number;
}

/**
 * Resolve a typed target to candidate locators across ALL frames.
 * Returns every match; callers treat >1 as `ambiguous_target` and 0 as
 * `target_not_found` — then the fallback controller takes over.
 */
export async function resolveTargetLocators(
  page: Page,
  t: TargetSpec,
): Promise<ResolvedTarget[]> {
  const out: ResolvedTarget[] = [];
  const frames = page.frames();
  for (const frame of frames) {
    let loc: Locator | null = null;
    if (t.selector) loc = frame.locator(t.selector);
    else if (t.role) {
      loc = t.name
        ? frame.getByRole(t.role as never, { name: t.name, exact: false })
        : frame.getByRole(t.role as never);
    } else if (t.label) loc = frame.getByLabel(t.label, { exact: false });
    else if (t.text) loc = frame.getByText(t.text, { exact: false });
    if (!loc) continue;
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 6); i++) out.push({ locator: loc.nth(i), frame });
  }
  return out;
}

/** Locate an element for the highlight overlay (bounding box owner). */
export function refBoundingBoxLocator(
  page: Page,
  s: PageSnapshot,
  ref: string,
): Locator | null {
  return resolveRefLocator(page, s, ref)?.locator ?? null;
}
