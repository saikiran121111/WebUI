import { describe, it, expect } from "vitest";
import { extractBrowserApiFence } from "@/lib/browser/browserToolProtocol";

describe("extractBrowserApiFence", () => {
  it("parses a navigate fence", () => {
    const c = 'I will open it now.\n\n```browser_api\n{"action":"navigate","url":"https://www.linkedin.com/in/kiran-teja-asapu-037"}\n```\nDone.';
    const a = extractBrowserApiFence(c);
    expect(a).not.toBeNull();
    expect(a!.action).toBe("navigate");
    expect(a!.url).toContain("linkedin.com");
  });

  it("rejects the removed play_embed / panel vocabulary entirely", () => {
    const c = '```browser_api\n{"action":"play_embed","url":"https://www.youtube.com/watch?v=j61QtWB1zj0&list=RDtXvCxbclgmc&index=5"}\n```';
    expect(extractBrowserApiFence(c)).toBeNull();
  });

  it("ignores a partial (streaming) fence", () => {
    const c = '```browser_api\n{"action":"navigate","url":"https://ex';
    expect(extractBrowserApiFence(c)).toBeNull();
  });

  it("rejects an unknown action keyword", () => {
    const c = '```browser_api\n{"action":"hack","url":"x"}\n```';
    expect(extractBrowserApiFence(c)).toBeNull();
  });

  it("returns the LAST complete valid fence when several are present", () => {
    const c =
      '```browser_api\n{"action":"navigate","url":"https://a.com"}\n```\n' +
      'then:\n```browser_api\n{"action":"click","text":"Back to top"}\n```';
    const a = extractBrowserApiFence(c);
    expect(a!.action).toBe("click");
    expect(a!.text).toBe("Back to top");
  });
});

describe("extractBrowserApiFence — semantic protocol only (legacy vocabulary removed)", () => {
  const fence = (obj: unknown) =>
    "```browser_api\n" + JSON.stringify(obj) + "\n```";

  it("rejects the removed legacy action names outright", () => {
    for (const action of ["scroll", "back", "reload", "type", "done_login", "start", "play_media"]) {
      expect(extractBrowserApiFence(fence({ action }))).toBeNull();
    }
  });

  it("parses fill with a ref target and value", () => {
    const a = extractBrowserApiFence(
      fence({ action: "fill", ref: "e7", value: "Springfield" }),
    );
    expect(a!.action).toBe("fill");
    expect(a!.ref).toBe("e7");
    expect(a!.value).toBe("Springfield");
  });

  it("parses frame-qualified refs and snapshotId targets", () => {
    const a = extractBrowserApiFence(
      fence({ action: "click", ref: "f1:e4", snapshotId: 12 }),
    );
    expect(a!.ref).toBe("f1:e4");
    expect(a!.snapshotId).toBe(12);
  });

  it("parses typed targets (role+name / label / text / selector)", () => {
    expect(extractBrowserApiFence(fence({ action: "click", role: "button", name: "Sign in" }))!.name).toBe("Sign in");
    expect(extractBrowserApiFence(fence({ action: "fill", label: "Email", value: "a@b.c" }))!.label).toBe("Email");
    expect(extractBrowserApiFence(fence({ action: "click", text: "Continue" }))!.text).toBe("Continue");
    expect(extractBrowserApiFence(fence({ action: "hover", selector: "#menu" }))!.selector).toBe("#menu");
  });

  it("parses select / check / hover / press", () => {
    expect(extractBrowserApiFence(fence({ action: "select", ref: "e5", value: "pro" }))!.action).toBe("select");
    const chk = extractBrowserApiFence(fence({ action: "check", ref: "e3", checked: false }));
    expect(chk!.checked).toBe(false);
    const pr = extractBrowserApiFence(fence({ action: "press", ref: "e2", keys: ["Enter"] }));
    expect(pr!.keys).toEqual(["Enter"]);
  });

  it("parses keyboard_nav with a bounded key list", () => {
    const a = extractBrowserApiFence(fence({ action: "keyboard_nav", keys: ["Tab", "Tab", "Enter"] }));
    expect(a!.keys).toEqual(["Tab", "Tab", "Enter"]);
  });

  it("caps keys at 40 and filters empty/oversized entries", () => {
    const keys = [...Array(41).keys()].map(() => "a") as string[];
    const a = extractBrowserApiFence(fence({ action: "keyboard_nav", keys }));
    expect(a!.keys!.length).toBe(40);
    const b = extractBrowserApiFence(fence({ action: "keyboard_nav", keys: ["", "x".repeat(30), "Tab"] }));
    expect(b!.keys).toEqual(["Tab"]);
  });

  it("parses fill_form with fields and submitMode (default stays prepare_only on the server)", () => {
    const a = extractBrowserApiFence(
      fence({
        action: "fill_form",
        fields: [
          { label: "Name", value: "Ada" },
          { ref: "e3", checked: true },
        ],
        submitMode: "prepare_only",
      }),
    );
    expect(a!.fields!.length).toBe(2);
    expect(a!.fields![1].checked).toBe(true);
    expect(a!.submitMode).toBe("prepare_only");
  });

  it("caps fill_form fields at 32", () => {
    const fields = [...Array(33).keys()].map((i) => ({ ref: `e${i}`, value: "v" }));
    const a = extractBrowserApiFence(fence({ action: "fill_form", fields }));
    expect(a!.fields!.length).toBe(32);
  });

  it("rejects an invalid submitMode value", () => {
    const a = extractBrowserApiFence(fence({ action: "fill_form", fields: [{ ref: "e1" }], submitMode: "yolo" }));
    expect(a!.submitMode).toBeUndefined();
  });

  it("parses batch steps and filters non-batchable ones (nested batch, resume, authorize)", () => {
    const a = extractBrowserApiFence(
      fence({
        action: "batch",
        steps: [
          { action: "navigate", url: "https://example.com" },
          { action: "fill", ref: "e1", value: "x" },
          { action: "batch", steps: [] },
          { action: "resume_task" },
          { action: "authorize_browser_access" },
        ],
      }),
    );
    expect(a!.steps!.length).toBe(2);
    expect(a!.steps!.map((s) => s.action)).toEqual(["navigate", "fill"]);
  });

  it("caps batch steps at 8 and drops a steps array of nothing valid", () => {
    const many = [...Array(9).keys()].map(() => ({ action: "click", ref: "e1" }));
    expect(extractBrowserApiFence(fence({ action: "batch", steps: many }))!.steps!.length).toBe(8);
    const none = extractBrowserApiFence(fence({ action: "batch", steps: [{ action: "resume_task" }] }));
    expect(none!.steps).toBeUndefined();
  });

  it("parses resume_task and authorize_browser_access", () => {
    expect(extractBrowserApiFence(fence({ action: "resume_task" }))!.action).toBe("resume_task");
    expect(extractBrowserApiFence(fence({ action: "authorize_browser_access" }))!.action).toBe("authorize_browser_access");
  });

  it("copies confirmConsequential as ADVISORY only (server never trusts it alone)", () => {
    const a = extractBrowserApiFence(fence({ action: "click", role: "button", name: "Place order", confirmConsequential: true }));
    expect(a!.confirmConsequential).toBe(true);
  });

  it("raw coordinate fields are dropped (semantic targets only)", () => {
    const a = extractBrowserApiFence(fence({ action: "click", ref: "e1", x: 999999, y: -450000 }));
    expect(a!.action).toBe("click");
    expect(a!.ref).toBe("e1");
    expect(a).not.toHaveProperty("x");
    expect(a).not.toHaveProperty("y");
  });

  it("skips a fence body over the 16 KB size cap", () => {
    const huge = fence({ action: "fill", ref: "e1", value: "A".repeat(17000) });
    expect(huge.length).toBeGreaterThan(16000);
    expect(extractBrowserApiFence(huge)).toBeNull();
  });

  it("ignores non-object JSON bodies", () => {
    expect(extractBrowserApiFence("```browser_api\nnull\n```")).toBeNull();
    expect(extractBrowserApiFence('```browser_api\n"navigate"\n```')).toBeNull();
    expect(extractBrowserApiFence("```browser_api\n[]\n```")).toBeNull();
  });

  it("value text is capped at 1000 chars", () => {
    const a = extractBrowserApiFence(fence({ action: "fill", ref: "e1", value: "z".repeat(1500) }));
    expect(a!.value!.length).toBe(1000);
  });
});
