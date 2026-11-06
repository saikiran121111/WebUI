import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * FORM PRE-FLIGHT + READ-BACK SEMANTICS IN REAL CHROMIUM (2026-11-06 audit —
 * findings 1 and 2).  The Rust side is unit-tested, but the two scripts it
 * injects (`FORM_PROBE_JS`, `FORM_READ_JS` in
 * `rust-backend/crates/ruke-browser/src/bridge.rs`) only ever ran inside a live
 * page, so their DOM assumptions were never pinned.  This suite extracts the
 * PRODUCTION source text out of bridge.rs (no copy to drift) and evaluates it in
 * real Chromium against controlled fixtures.
 *
 * Determinism law: `page.setContent` fixtures, zero dev server, zero model
 * traffic.  The fixtures are authored here — nothing external is visited, so no
 * consequential action is taken against a real site.
 */

const BRIDGE = path.join(
  process.cwd(),
  "rust-backend",
  "crates",
  "ruke-browser",
  "src",
  "bridge.rs",
);

/** Pull a `r#"…"#` raw-string constant out of the Rust source verbatim. */
function rustRawConst(src: string, name: string): string {
  const re = new RegExp(`const ${name}: &str = r#"(.*?)"#;`, "s");
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found in bridge.rs — the form batch lost its probe/read script`);
  return m[1];
}

const src = fs.readFileSync(BRIDGE, "utf8");
const PROBE = rustRawConst(src, "FORM_PROBE_JS");
const READ = rustRawConst(src, "FORM_READ_JS");

type Spec = { target: string; type: string };
type State = { found: boolean; actual: string; alt?: string | null };

/**
 * Instantiate the production script text as a function so Playwright can call it
 * with an argument (a bare string would be evaluated as an expression, not
 * invoked).  `Function.prototype.toString` then hands Playwright the SAME source
 * that bridge.rs ships — there is no second copy here to drift out of sync.
 */
// eslint-disable-next-line no-new-func -- the whole point: run bridge.rs's own text
const PROBE_FN = new Function(`return (${PROBE})`)() as (s: Spec[]) => (string | null)[];
// eslint-disable-next-line no-new-func -- ditto
const READ_FN = new Function(`return (${READ})`)() as (s: Spec[]) => State[];

/** The page the probe and read-back run against — one fixture, many targets. */
const FIXTURE = `<!doctype html><html><body>
  <form>
    <input id="name" type="text" value="hello">
    <textarea id="notes">plain</textarea>
    <select id="plan">
      <option value="free">Free</option>
      <option value="business" selected>Business</option>
    </select>
    <input id="agree" type="checkbox" checked>
    <input id="opt-a" type="radio" name="opt" checked>
    <input id="vol" type="range" min="0" max="10" value="4">
    <div id="widget2" role="combobox" tabindex="0" aria-expanded="false">Choose a plan</div>
    <div id="widget" role="combobox" tabindex="0" aria-disabled="true" aria-expanded="false">Locked plan picker</div>
    <input id="notdisabled" type="text" aria-disabled="false">
    <fieldset disabled><input id="locked" type="text"></fieldset>
    <input id="off" type="text" disabled>
    <input id="ro" type="text" readonly>
    <input id="hid" type="text" style="display:none">
    <input id="vis" type="text" style="visibility:hidden">
    <input id="pe" type="text" style="pointer-events:none">
    <input class="dup" type="text"><input class="dup" type="text">
    <button id="btn" type="submit">Go</button>
    <input id="cleared" type="text" value="">
  </form>
</body></html>`;

test("the pre-flight probe rejects every unusable target and accepts the usable ones", async ({ page }) => {
  await page.setContent(FIXTURE);

  const specs: Spec[] = [
    // Usable controls must read as null, including custom ARIA widgets.
    { target: "#name", type: "textbox" },
    { target: "#notes", type: "textbox" },
    { target: "#plan", type: "combobox" },
    { target: "#agree", type: "checkbox" },
    { target: "#opt-a", type: "radio" },
    { target: "#vol", type: "slider" },
    { target: "#widget2", type: "combobox" },
    { target: "#notdisabled", type: "textbox" },
    // Usability failures the OLD probe waved through (audit finding 2).
    { target: "#widget", type: "combobox" },
    { target: "#locked", type: "textbox" },
    { target: "#vis", type: "textbox" },
    { target: "#pe", type: "textbox" },
    // Pre-existing failures that must keep working.
    { target: "#off", type: "textbox" },
    { target: "#ro", type: "textbox" },
    { target: "#hid", type: "textbox" },
    { target: "#gone", type: "textbox" },
    { target: ".dup", type: "textbox" },
    { target: "##oops", type: "textbox" },
    // Type-correctness failures.
    { target: "#btn", type: "textbox" },
    { target: "#name", type: "checkbox" },
    { target: "#name", type: "combobox" },
    { target: "#name", type: "slider" },
    { target: "#agree", type: "radio" },
  ];

  const verdicts = await page.evaluate(PROBE_FN, specs);

  // The response contract `probe_verdicts` enforces in Rust must hold against
  // the real page: exactly one entry per field, each null or a non-empty string.
  expect(verdicts, "one verdict per field").toHaveLength(specs.length);
  for (const [i, v] of verdicts.entries()) {
    const okShape = v === null || (typeof v === "string" && v.length > 0);
    expect(okShape, `verdict ${i} (${specs[i].target}) is ${JSON.stringify(v)}`).toBeTruthy();
  }

  const at = (target: string, type: string) => verdicts[specs.findIndex(s => s.target === target && s.type === type)];
  const rejected = (target: string, type: string, why: RegExp) => {
    const v = at(target, type);
    expect(typeof v === "string" && why.test(v as string), `${target}/${type} => ${JSON.stringify(v)}`).toBeTruthy();
  };

  for (const t of ["#name/textbox", "#notes/textbox", "#plan/combobox", "#agree/checkbox", "#opt-a/radio", "#vol/slider", "#widget2/combobox", "#notdisabled/textbox"]) {
    const [target, type] = t.split("/");
    expect(at(target, type), `${t} must be usable`).toBeNull();
  }

  // aria-disabled custom widget: `el.disabled` is undefined, so the old probe
  // passed it and the driver failed mid-batch.
  rejected("#widget", "combobox", /aria-disabled/);
  // A control in a disabled <fieldset> is disabled without `el.disabled` set.
  rejected("#locked", "textbox", /disabled <fieldset>/);
  // Invisible-but-laid-out controls: getClientRects() is non-empty, so only a
  // computed-style check catches them.
  rejected("#vis", "textbox", /visible|cannot receive input/);
  rejected("#pe", "textbox", /cannot receive input/);

  rejected("#off", "textbox", /element is disabled/);
  rejected("#ro", "textbox", /read-only/);
  rejected("#hid", "textbox", /not visible/);
  rejected("#gone", "textbox", /no element matches/);
  rejected(".dup", "textbox", /not unique \(2 elements match\)/);
  rejected("##oops", "textbox", /not a valid CSS selector/);

  rejected("#btn", "textbox", /not a textbox/);
  rejected("#name", "checkbox", /not a checkbox/);
  rejected("#name", "combobox", /not a combobox/);
  rejected("#name", "slider", /not a slider/);
  rejected("#agree", "radio", /not a radio button/);
});

test("the read-back tells applied, cleared and UNVERIFIABLE apart (finding 1)", async ({ page }) => {
  await page.setContent(FIXTURE);

  const specs: Spec[] = [
    { target: "#name", type: "textbox" },
    { target: "#cleared", type: "textbox" },
    { target: "#plan", type: "combobox" },
    { target: "#agree", type: "checkbox" },
    { target: "#vol", type: "slider" },
    { target: "#gone", type: "textbox" },
    { target: ".dup", type: "textbox" },
    { target: "##oops", type: "textbox" },
  ];
  const states = await page.evaluate(READ_FN, specs);
  expect(states).toHaveLength(specs.length);

  const at = (target: string) => states[specs.findIndex(s => s.target === target)];

  // A field the page COULD be read for: found:true is what makes "holds its
  // intended value" mean anything at all.
  expect(at("#name")).toMatchObject({ found: true, actual: "hello" });
  // A genuinely cleared box is found:true with an empty value — this is the
  // state the old success path confused with the next one, which is why
  // clearing a box used to report `verified: true` without reading the page.
  expect(at("#cleared")).toMatchObject({ found: true, actual: "" });
  // An unreadable target (missing, ambiguous, invalid selector) is found:false.
  // Rust's form_readback_response maps exactly that to "unverifiable", and it
  // never counts toward `applied` — pinned by bridge.rs unit tests.
  for (const t of ["#gone", ".dup", "##oops"]) {
    expect(at(t), `${t} must read as unverifiable`).toEqual({ found: false, actual: "" });
  }
  // Selects report both the visible option text and its value attribute, so a
  // pick can be confirmed by either.
  expect(at("#plan")).toMatchObject({ found: true, actual: "Business", alt: "business" });
  expect(at("#agree")).toMatchObject({ found: true, actual: "true" });
  expect(at("#vol")).toMatchObject({ found: true, actual: "4" });
});

test("nothing was applied by the probe alone: pre-flight is read-only", async ({ page }) => {
  await page.setContent(FIXTURE);
  const readName = () => page.evaluate(() => (document.querySelector("#name") as HTMLInputElement).value);
  const before = await readName();

  // A good field and an unusable one in the same batch: the probe answers both
  // (and the Rust side stops the batch with ZERO side-effects on that answer),
  // and answering must not touch a single value on the page.
  const verdicts = await page.evaluate(PROBE_FN, [
    { target: "#name", type: "textbox" },
    { target: "#locked", type: "textbox" },
  ]);
  expect(verdicts[0], "the good field is usable").toBeNull();
  expect(String(verdicts[1])).toMatch(/disabled <fieldset>/);

  expect(await readName(), "the probe must never write to the page").toBe(before);
  const states = await page.evaluate(READ_FN, [{ target: "#name", type: "textbox" }]);
  expect(states[0], "the read-back is a read, not a write").toMatchObject({ found: true, actual: before });
});
