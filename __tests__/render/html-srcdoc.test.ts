import { describe, it, expect } from "vitest";
import {
  buildSrcDoc,
  HTML_ARTIFACT_SANDBOX,
  INVERT_LUMA_THRESHOLD,
  RESIZE_SCRIPT,
  STORAGE_SHIM_SCRIPT,
  shouldInvert,
} from "../../lib/render/htmlSrcDoc";

/**
 * Finding 6 of the 2026-11-06 audit: the ```html artifact preview renders MODEL
 * output, and it used to run `sandbox="allow-scripts allow-same-origin"` on a
 * srcDoc frame — which inherits the parent origin, so the artifact had the APP's
 * own origin (parent DOM, cookies, storage, authenticated API reads). The repair
 * drops `allow-same-origin`; the two features that leaned on that grant (the
 * light-background luma probe and artifact localStorage) moved INSIDE the frame.
 * These tests pin the sandbox contract, the injection points the frame features
 * depend on, and the shim's behavior when the native storage accessor throws.
 */

describe("artifact sandbox contract (finding 6)", () => {
  it("keeps scripts enabled and NEVER re-grants the parent origin", () => {
    expect(HTML_ARTIFACT_SANDBOX).toContain("allow-scripts");
    // Regression guard: this pair is the whole vulnerability.
    expect(HTML_ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    // The artifact still cannot navigate the chat page, open windows or submit forms.
    for (const forbidden of ["allow-top-navigation", "allow-popups", "allow-forms", "allow-pointer-lock"]) {
      expect(HTML_ARTIFACT_SANDBOX).not.toContain(forbidden);
    }
  });

  it("carries the luma probe inside the resize script instead of reading across documents", () => {
    expect(RESIZE_SCRIPT).toContain("HTML_VIEWER_RESIZE");
    expect(RESIZE_SCRIPT).toContain("luma:");
    expect(RESIZE_SCRIPT).toContain("getComputedStyle");
    // Rec.709 weights, matching the probe the viewer has always used.
    for (const w of ["0.2126", "0.7152", "0.0722"]) expect(RESIZE_SCRIPT).toContain(w);
  });
});

describe("buildSrcDoc injection points", () => {
  it("wraps a fragment and injects the shim before the artifact's own script", () => {
    const out = buildSrcDoc('<div id="a"><script>var marker = 1;</script></div>');
    expect(out.startsWith("<!DOCTYPE html><html>")).toBe(true);
    expect(out).toContain("<style>html,body{margin:0;background:#000000");
    const shimAt = out.indexOf(STORAGE_SHIM_SCRIPT);
    const artifactScript = out.indexOf("var marker = 1;");
    const resizeAt = out.indexOf(RESIZE_SCRIPT);
    expect(shimAt).toBeGreaterThanOrEqual(0);
    expect(artifactScript).toBeGreaterThan(shimAt); // storage ready before artifact code runs
    expect(resizeAt).toBeGreaterThan(artifactScript);
    expect(out.endsWith(RESIZE_SCRIPT + "</body></html>")).toBe(true);
    // Exactly one of each injected script — never duplicated per re-render.
    expect(out.indexOf(STORAGE_SHIM_SCRIPT)).toBe(out.lastIndexOf(STORAGE_SHIM_SCRIPT));
    expect(out.indexOf(RESIZE_SCRIPT)).toBe(out.lastIndexOf(RESIZE_SCRIPT));
  });

  it("keeps a full model document verbatim apart from the two injections", () => {
    const src =
      '<!DOCTYPE html><html lang="en"><head><title>Q3</title><script>var own = 1;</script></head>' +
      '<body><h1>Quarterly</h1></body></html>';
    const out = buildSrcDoc(src);
    expect(out).toContain('<html lang="en">');
    expect(out).toContain("<title>Q3</title>");
    expect(out).toContain("<h1>Quarterly</h1>");
    expect(out.match(/<head>/gi)!.length).toBe(1);
    expect(out.indexOf(STORAGE_SHIM_SCRIPT)).toBeLessThan(out.indexOf("var own = 1;"));
    expect(out.indexOf(STORAGE_SHIM_SCRIPT)).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf(RESIZE_SCRIPT)).toBeGreaterThan(out.indexOf("<h1>Quarterly</h1>"));
  });

  it("synthesizes a head when the document has <html> but no </head>", () => {
    const out = buildSrcDoc('<html><body><p id="p">text</p></body></html>');
    expect(out).toContain('<html><head>' + STORAGE_SHIM_SCRIPT + "</head>");
    expect(out).toContain('<p id="p">text</p>');
  });

  it("handles a bare fragment with no <html>/<head>/<body> of its own", () => {
    const out = buildSrcDoc('<p id="solo">hi</p>');
    expect(out).toContain('<p id="solo">hi</p>');
    expect(out.indexOf(STORAGE_SHIM_SCRIPT)).toBeLessThan(out.indexOf('<p id="solo">'));
    expect(out).toContain(RESIZE_SCRIPT + "</body></html>");
  });

  it("never lets replacement metacharacters in model HTML corrupt the document", () => {
    // String.replace with a string replacement expands $&, $', $1, $` — model
    // artifacts (jQuery-heavy markup, minified code) hit this constantly.
    const tricky = `<div id="m">cost $& and $' backtick \` plus $1$2$3</div>`;
    const out = buildSrcDoc(tricky);
    expect(out).toContain("cost $& and $' backtick ` plus $1$2$3");
  });
});

describe("invert decision (luma rides the message)", () => {
  it("inverts only a measurable light background", () => {
    expect(shouldInvert(1)).toBe(true); // #FFFFFF report
    expect(shouldInvert(INVERT_LUMA_THRESHOLD + 0.001)).toBe(true);
    expect(shouldInvert(INVERT_LUMA_THRESHOLD)).toBe(false);
    expect(shouldInvert(0)).toBe(false); // #000000 canvas
  });

  it("defaults to no invert when the frame cannot measure the background", () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, "1", true, {}, []]) {
      expect(shouldInvert(bad)).toBe(false);
    }
  });
});

/** Run the injected shim body against a stub window. */
function runShim(win: Record<string, unknown>) {
  const body = STORAGE_SHIM_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "");
  new Function("window", body).call(win, win);
}

describe("storage shim (artifacts keep remembering state, off the app origin)", () => {
  it("replaces accessors that throw SecurityError under an opaque origin", () => {
    const win: Record<string, unknown> = {};
    for (const n of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(win, n, {
        configurable: true,
        get() {
          throw new Error("SecurityError: access to storage is denied");
        },
      });
    }
    runShim(win);

    const ls = win.localStorage as Storage;
    expect(ls.getItem("missing")).toBe(null);
    ls.setItem("greeting", "hello");
    expect(ls.getItem("greeting")).toBe("hello");
    expect(ls.length).toBe(1);
    expect(ls.key(0)).toBe("greeting");
    expect(ls.key(1)).toBe(null);
    ls.removeItem("greeting");
    expect(ls.getItem("greeting")).toBe(null);
    ls.setItem("a", "1");
    ls.setItem("b", "2");
    ls.clear();
    expect(ls.length).toBe(0);
    expect(win.sessionStorage).toBeTruthy();
  });

  it("coerces keys and values to strings like the real Storage", () => {
    const win: Record<string, unknown> = {};
    Object.defineProperty(win, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
    Object.defineProperty(win, "sessionStorage", { configurable: true, get() { throw new Error("denied"); } });
    runShim(win);
    const ls = win.localStorage as Storage;
    ls.setItem(1 as unknown as string, 2 as unknown as string);
    expect(ls.getItem("1")).toBe("2");
    expect(ls.getItem(1 as unknown as string)).toBe("2");
    expect(ls.key(0)).toBe("1");
  });

  it("shims when the accessor is simply absent, and leaves real storage alone", () => {
    const absentWin: Record<string, unknown> = {};
    runShim(absentWin);
    expect(typeof (absentWin.localStorage as Storage).getItem).toBe("function");

    const native = { getItem: () => "real", setItem: () => undefined };
    const nativeWin: Record<string, unknown> = { localStorage: native, sessionStorage: native };
    runShim(nativeWin);
    expect(winIsUntouched(nativeWin, native));
  });
});

function winIsUntouched(win: Record<string, unknown>, native: unknown): boolean {
  return win.localStorage === native && win.sessionStorage === native;
}
