/**
 * Executes a model-authored ```threejs fence inside the live studio scene.
 *
 * The fence body is wrapped in a function scope with THREE / root / api
 * bound — no imports, no module syntax, no access to anything else in the
 * app. Rigid scene3d JSON primitives cannot express an Iron Man helmet, a
 * sneaker, or an extruded logo; executable Three.js can, and every named
 * THREE.Group / THREE.Mesh the code creates is auto-indexed so the outliner,
 * picking, gizmos, explode and exporters keep working.
 */

export interface ThreeCodeRunOk {
  ok: true;
  root: any; // THREE.Group holding everything the code added
  onUpdate: ((delta: number, elapsed: number) => void) | null;
}
export interface ThreeCodeRunFail { ok: false; error: string }
export type ThreeCodeRunResult = ThreeCodeRunOk | ThreeCodeRunFail;

const IMPORT_LINE = /^[ \t]*import\s[^\n]*$/gm;
const EXPORT_PREFIX = /^[ \t]*export\s+(default\s+)?/gm;

/** Cheap static gate for ```js fences: real Three.js scene code, not a tutorial snippet. */
export function looksLikeThreeCode(source: string): boolean {
  return /\bnew\s+THREE\.[A-Za-z]+\(/.test(source) && /\b(root|api|scene)\s*\.\s*add\s*\(/.test(source);
}

const errText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Run the fence. The code may either add to `root` directly at top level,
 * or define `function build(THREE, root, api)` / `function main(...)` which
 * we invoke. An `onUpdate(delta, elapsed)` function (top-level or
 * `api.onUpdate`) is returned so the viewer can drive the animation loop.
 */
export function runThreeCode(three: any, source: string): ThreeCodeRunResult {
  const cleaned = source.replace(IMPORT_LINE, "").replace(EXPORT_PREFIX, "");
  const root = new three.Group();
  root.name = "threejs-code";
  const api: Record<string, unknown> = { three, root };

  let factory: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line no-new-func -- deliberate: STEP 3 of the 3D pipeline runs model-authored Three.js in a bound scope with no app references.
    factory = new Function(
      "THREE", "root", "api",
      `"use strict";\n${cleaned}\n` +
      `if (typeof build === "function") build(THREE, root, api);\n` +
      `if (typeof main === "function") main(THREE, root, api);\n` +
      `return typeof onUpdate === "function" ? onUpdate : (api && typeof api.onUpdate === "function" ? api.onUpdate : null);`,
    ) as unknown as (...args: unknown[]) => unknown;
  } catch (err) {
    return { ok: false, error: `syntax error — ${errText(err)}` };
  }

  let onUpdate: ((delta: number, elapsed: number) => void) | null = null;
  try {
    const returned = factory(three, root, api);
    if (typeof returned === "function") onUpdate = returned as (d: number, e: number) => void;
  } catch (err) {
    return { ok: false, error: `runtime error — ${errText(err)}` };
  }

  if (root.children.length === 0) {
    return { ok: false, error: "the code produced an empty scene — nothing was added to root" };
  }

  // Index every named object: userData.nodeId is what pick()/select()/
  // explode()/export use, so named parts get the full studio treatment.
  root.traverse((obj: any) => {
    if (obj.name && !obj.userData.nodeId) obj.userData.nodeId = obj.name;
    if (!obj.userData.label) obj.userData.label = obj.name || obj.type;
  });

  return { ok: true, root, onUpdate };
}
