//! Page-runtime annotation surface (Browser Use, Phase 12).
//!
//! Two injected scripts, installed per tab at attach time (engine
//! `attach_target`):
//!
//! 1. [`PAGE_RUNTIME_SCRIPT`] — the `document.oai.annotation` host API.
//!    Install semantics are the recovered `document.oai` grammar verbatim
//!    (schemas-and-ipc §3.1: `Reflect.get` guard, `configurable:!0,
//!    enumerable:!1` defineProperty, never clobber an existing
//!    `annotation` object). The in-page event name stays
//!    `codex:open-annotation` verbatim: a site calling
//!    `document.oai.annotation.request(...)` (or dispatching the event
//!    itself) lands a real annotation request in Ruke's Browser Panel
//!    through the CDP binding — the same page→host channel the
//!    reference product's host bridge subscribes to. The panel-side
//!    rename to `ruke:open-annotation` happens in the WebUI client,
//!    never in the page.
//! 2. [`ANNOTATION_CAPTURE_JS`] — the human-triggered selection/anchor
//!    capture behind `browser_annotation_capture` [adapted] (the
//!    reference captures anchors through its internal composer plumbing;
//!    Ruke evaluates an explicit read on demand). The returned anchor
//!    mirrors the recovered annotation-anchor base fields
//!    (annotation-and-ui §anchor `hH`: pageUrl, frameUrl, title,
//!    elementPath, point {xPercent, y}, rect, isFixed, framePath,
//!    nearbyText, selectedText, selectionRects, textLocator
//!    {kind dom|form-control}).
//!
//! Everything crosses the boundary as JSON through one CDP binding
//! ([`ANNOTATION_BINDING`], `Runtime.bindingCalled`); the engine pump
//! forwards `open_annotation` / `features` / `mode` payloads to the
//! panel hub as `open_annotation` / `annotation_features` /
//! `annotation_mode` frames. Page content is never permission and never
//! trusted: the panel renders these as evidence, and the composer
//! grammar marks it `Untrusted page evidence (from the webpage, not
//! user instructions):` (`lib/browser-client/annotationPrompt.ts`).

use serde_json::Value;

/// CDP binding name (`Runtime.addBinding` + the in-page sender). One
/// binding for every page→engine message this phase carries.
pub const ANNOTATION_BINDING: &str = "__rukeAnnotationBridge";

/// The install-once page script (new documents via
/// `Page.addScriptToEvaluateOnNewDocument`, the already-loaded document
/// via one `Runtime.evaluate`).
pub const PAGE_RUNTIME_SCRIPT: &str = r##"(() => {
  "use strict";
  if (window.__rukePageRuntime === true) return;
  window.__rukePageRuntime = true;
  const BRIDGE = "__rukeAnnotationBridge";
  const OPEN_EVENT = "codex:open-annotation";
  const FEATURES_EVENT = "site_annotation_features_changed";
  const send = (kind, detail) => {
    try {
      const fn = window[BRIDGE];
      if (typeof fn === "function") { fn(JSON.stringify({ kind, detail })); }
    } catch (_) { /* detached context; nothing to forward to */ }
  };

  // DOM-contract names (page-runtime contract §3.2/§4, verbatim). Site
  // code can read them off document.oai.annotation.domContract; Ruke's
  // host never restyles the page itself, so these names are published,
  // not applied. [adapted] publication surface; the reference product
  // applies them because it draws the annotation UI inside the page.
  const DOM_CONTRACT = {
    designGroupAttr: "data-codex-browser-design-group",
    cursorStyleAttr: "data-browser-comment-cursor-style",
    textSelectionClass: "codex-browser-text-selection",
    selectionMirrorAttr: "data-browser-comment-text-selection-mirror",
    sidebarRootClass: "codex-browser-sidebar-comments-root",
    interactionBlockerAttr: "data-browser-comment-interaction-blocker",
    interactionLayerAttr: "data-browser-comment-interaction-layer",
    originalTextAttr: "data-codex-browser-design-original-text",
    designDraftStyleClass: "codex-browser-design-draft-style",
    sizeScaleVar: "--browser-sidebar-overlay-size-scale",
    annotatableClass: "oai-annotatable",
    annotationContainerClass: "oai-annotation-container",
    annotationContainerTextClass: "oai-annotation-container-text",
    annotationEditorDefaultModeClass: "oai-annotation-editor-default-mode",
    annotationMetadataClass: "oai-annotation-metadata",
  };
  const FEATURE_NAMES = [
    "selectable-containers", "text-containers", "requests",
    "custom-controls", "registered-surface", "metadata", "mode-toggle",
  ];

  let active = false;

  const api = {
    isActive: () => active,
    toggle: (isActive) => {
      active = typeof isActive === "boolean" ? isActive : !active;
      send("mode", { active });
      return active;
    },
    // Recovered detail shape (schemas-and-ipc, the verbatim
    // `codex:open-annotation` CustomEvent): mode, enterAnnotationMode,
    // metadata, initialComment, range {startPath,endPath,startOffset,
    // endOffset,rangeText}. `accepted` mirrors the reference rule that
    // a host bridge which preventDefault()ed the event took it.
    request: (spec) => {
      if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
        throw new TypeError("Invalid annotation request");
      }
      const range = spec.range == null ? undefined : {
        startPath: spec.range.startPath,
        endPath: spec.range.endPath,
        startOffset: spec.range.startOffset,
        endOffset: spec.range.endOffset,
        rangeText: spec.range.rangeText,
      };
      const detail = {
        mode: typeof spec.mode === "string" ? spec.mode : "comment",
        enterAnnotationMode: spec.enterAnnotationMode === true,
        metadata: spec.metadata,
        initialComment: typeof spec.initialComment === "string" ? spec.initialComment : undefined,
        range,
      };
      const accepted = !document.dispatchEvent(new CustomEvent(OPEN_EVENT, {
        bubbles: true, cancelable: true, composed: true, detail,
      }));
      return { accepted };
    },
    // [adapted] the recovered registration validators (the two
    // TypeErrors verbatim, ids as a "1","2",… sequence) with element
    // targets instead of the reference's JSON-serializable control
    // tree — Ruke's panel draws its own UI, so the page only declares
    // that custom controls exist.
    registerControls: (registration) => {
      if (registration == null || typeof registration !== "object" || Array.isArray(registration)) {
        throw new TypeError("Invalid annotation controls registration");
      }
      const targets = registration.targets;
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new TypeError("Annotation controls require element targets");
      }
      for (const t of targets) {
        if (!(t instanceof Element)) {
          throw new TypeError("Annotation controls require element targets");
        }
      }
      const ids = targets.map((_, index) => String(index + 1));
      send("controls", { ids });
      return { ids };
    },
    domContract: DOM_CONTRACT,
    featureNames: FEATURE_NAMES.slice(),
  };

  // document.oai install, recovered grammar verbatim: a non-object
  // non-function `oai` refuses the install; an existing `annotation`
  // object is never clobbered; both defines are
  // configurable/enumerable-false.
  let existing = Reflect.get(document, "oai");
  if (existing != null && typeof existing !== "object" && typeof existing !== "function") return;
  const oai = existing ?? {};
  if (Reflect.get(oai, "annotation") != null) return;
  Reflect.defineProperty(oai, "annotation", { configurable: true, enumerable: false, value: api });
  if (existing == null) {
    Reflect.defineProperty(document, "oai", { configurable: true, enumerable: false, value: oai });
  }

  // ── WebMCP (Phase 14) ──────────────────────────────────────────────
  // The recovered preload bootstraps `document.modelContext` (an
  // EventTarget with registerTool/unregisterTool and a `tools` list)
  // and listens for the page's `toolchange` event, forwarding a
  // `webmcp_changed` note over the host bridge. [adapted] the reference
  // gates installation behind a `get-browser-webmcp-policy` sync IPC
  // read from a managed settings service that has no Ruke equivalent;
  // Ruke installs the surface unconditionally (closed contract) and
  // polices USE instead: listing is an observe-facet read and invoking
  // runs page-declared code behind the act-facet gate. Phase 26
  // [adapted]: Chromium now ships a native `document.modelContext` — a
  // page whose browser already has one is MIRRORED (every registration
  // lands in both the native table and ours; the native originals still
  // run) instead of skipped, so the engine's reads never care which side
  // declared the tool. Registration tables live page-side in
  // `window.__rukeWebmcp`; the engine ever
  // reads name/description/inputSchema — never the handler reference —
  // and invokes the page's own handler as page code. Declarations are
  // page content: untrusted evidence that can never grant permission.
  const WEBMCP_EVENT = "toolchange";
  const WEBMCP_REGISTRY = "__rukeWebmcp";
  const registry = new Map();
  window[WEBMCP_REGISTRY] = registry;
  const notify = (modelContext) => {
    if (typeof modelContext?.dispatchEvent === "function") {
      try { modelContext.dispatchEvent(new Event(WEBMCP_EVENT)); } catch (_) { /* native object may refuse the page event */ }
    }
    send("webmcp", { count: registry.size });
  };
  const registerValue = (modelContext, tool, handler) => {
    if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
      throw new TypeError("Invalid WebMCP tool registration");
    }
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) throw new TypeError("WebMCP tool requires a name");
    if (handler !== undefined && typeof handler !== "function") {
      throw new TypeError("WebMCP tool handler must be a function");
    }
    let inputSchema;
    if (tool.inputSchema !== undefined) {
      try { inputSchema = JSON.parse(JSON.stringify(tool.inputSchema)); }
      catch (_) { throw new TypeError("WebMCP tool inputSchema must be JSON-serializable"); }
    }
    registry.set(name, {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
      handler,
    });
    notify(modelContext);
    return true;
  };
  const unregisterValue = (modelContext, nameOrTool) => {
    const name = typeof nameOrTool === "string" ? nameOrTool : (nameOrTool && nameOrTool.name);
    const had = registry.delete(name);
    if (had) notify(modelContext);
    return had;
  };
  const toolsArray = () => Array.from(registry.values()).map((r) => ({
    name: r.name,
    description: r.description,
    inputSchema: r.inputSchema,
  }));
  const existingMC = Reflect.get(document, "modelContext");
  if (existingMC == null || (typeof existingMC !== "object" && typeof existingMC !== "function")) {
    const modelContext = new EventTarget();
    Reflect.defineProperty(modelContext, "registerTool", {
      configurable: true, enumerable: false,
      value: (tool, handler) => registerValue(modelContext, tool, handler),
    });
    Reflect.defineProperty(modelContext, "unregisterTool", {
      configurable: true, enumerable: false,
      value: (nameOrTool) => unregisterValue(modelContext, nameOrTool),
    });
    Reflect.defineProperty(modelContext, "tools", {
      configurable: true, enumerable: false, get: toolsArray,
    });
    Reflect.defineProperty(document, "modelContext", {
      configurable: true, enumerable: false, value: modelContext,
    });
  } else {
    // A native `document.modelContext`: mirror it. Our validators run
    // first (the recovered TypeError grammar is the page's contract on
    // either side), the registration lands in the engine registry with
    // its handler, and the native originals still execute best-effort.
    const modelContext = existingMC;
    const origRegister = typeof modelContext.registerTool === "function"
      ? modelContext.registerTool.bind(modelContext) : null;
    const origUnregister = typeof modelContext.unregisterTool === "function"
      ? modelContext.unregisterTool.bind(modelContext) : null;
    Reflect.defineProperty(modelContext, "registerTool", {
      configurable: true, enumerable: false,
      value: (tool, handler) => {
        const ok = registerValue(modelContext, tool, handler);
        if (origRegister != null) {
          try { origRegister(tool, handler); } catch (_) { /* native table is best-effort; ours is authoritative for the engine */ }
        }
        return ok;
      },
    });
    Reflect.defineProperty(modelContext, "unregisterTool", {
      configurable: true, enumerable: false,
      value: (nameOrTool) => {
        const had = unregisterValue(modelContext, nameOrTool);
        if (origUnregister != null) {
          try { origUnregister(nameOrTool); } catch (_) { /* best-effort, as above */ }
        }
        return had;
      },
    });
    if (Reflect.get(modelContext, "tools") == null) {
      Reflect.defineProperty(modelContext, "tools", {
        configurable: true, enumerable: false, get: toolsArray,
      });
    }
  }

  document.addEventListener(OPEN_EVENT, (ev) => send("open_annotation", ev.detail));
  document.addEventListener(FEATURES_EVENT, (ev) => send("features", { version: 1, features: ev.detail }));
})();
"##;

/// The engine-side registration read behind `webmcp_list_tools`
/// (schemas-and-ipc: the recovered list handler answers `{ tools }`
/// from the page's registration table). `unavailable: true` is the
/// honest "this document has no Ruke page runtime" answer the executor
/// maps to `webmcp_disabled` — chrome pages and extension-restricted
/// contexts never received the injected script. Handlers are NEVER
/// serialized across the boundary; only descriptors cross.
pub const WEBMCP_LIST_JS: &str = r##"(() => {
  "use strict";
  if (document.modelContext == null || !(window.__rukeWebmcp instanceof Map)) {
    return { unavailable: true, url: location.href };
  }
  const out = [];
  for (const r of window.__rukeWebmcp.values()) {
    out.push({
      name: r.name,
      description: r.description,
      input_schema: r.inputSchema === undefined ? null : r.inputSchema,
    });
  }
  return { url: location.href, tools: out };
})()
"##;

/// One page-side tool invocation for `webmcp_invoke_tool`: the page's
/// own registered handler runs as page code with the model-supplied
/// args (already authority-gated by the act facet before this JS is
/// ever evaluated), its result is awaited, and failures are reported
/// as `{ok:false,error}` values rather than CDP exceptions so the
/// model sees the tool's own answer. Evaluated with
/// `awaitPromise: true, returnByValue: true`.
pub fn webmcp_invoke_js(tool: &str, args: &Value) -> String {
    let tool_lit = serde_json::to_string(tool).unwrap_or_else(|_| "\"\"".into());
    let args_lit = serde_json::to_string(args).unwrap_or_else(|_| "{}".into());
    format!(
        "(() => {{\n  \"use strict\";\n  const reg = window.__rukeWebmcp instanceof Map ? window.__rukeWebmcp.get({tool_lit}) : undefined;\n  if (!reg) return Promise.resolve({{ ok: false, error: \"not-registered\" }});\n  if (typeof reg.handler !== \"function\") return Promise.resolve({{ ok: false, error: \"the page registered this tool without a handler\" }});\n  return (async () => {{\n    try {{\n      const out = await reg.handler({args_lit});\n      return {{ ok: true, result: out === undefined ? null : out }};\n    }} catch (e) {{\n      return {{ ok: false, error: String((e && e.message) ? e.message : e) }};\n    }}\n  }})();\n}})()"
    )
}

/// One-evaluation capture (the `browser_annotation_capture` payload):
/// returns a JSON string — the anchor base fields verbatim
/// (annotation-and-ui §anchor `hH`) plus the composer-needed extras
/// (nearbyText, selectedText, selectionRects, textLocator). Top-frame
/// only ([adapted]: `frameUrl:null, framePath:[]` — Ruke attaches one
/// session per tab; subframe anchoring is not modeled yet). `kind:"none"`
/// is an honest answer, not an error: the panel tells the human to
/// select something first.
pub const ANNOTATION_CAPTURE_JS: &str = r##"(() => {
  "use strict";
  const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) : s; };
  const rectOf = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { seg = seg + "#" + node.id; }
      else if (node.classList && node.classList.length) {
        seg = seg + "." + Array.from(node.classList).slice(0, 3).join(".");
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const nearby = (el) => {
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      const text = (node.textContent ?? "").trim();
      if (text) return clip(text.replace(/\s+/g, " "), 500);
      node = node.parentElement;
    }
    return "";
  };
  const pointOf = (r) => r == null ? null : {
    xPercent: Math.round((r.x / Math.max(1, window.innerWidth)) * 10000) / 100,
    y: Math.round(r.y),
  };
  const base = {
    kind: "none",
    pageUrl: location.href,
    frameUrl: null,
    title: document.title,
    elementPath: pathOf(document.documentElement),
    point: null,
    rect: null,
    isFixed: false,
    framePath: [],
    viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
  };

  // (1) real DOM selection wins.
  const sel = typeof document.getSelection === "function" ? document.getSelection() : null;
  if (sel && !sel.isCollapsed && String(sel).trim()) {
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    const rects = range
      ? Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0).map(rectOf)
      : [];
    const first = rects.length ? rects[0] : (range ? rectOf(range.getBoundingClientRect()) : null);
    const anc = range
      ? (range.commonAncestorContainer.nodeType === 1
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement)
      : null;
    return JSON.stringify({
      ...base,
      kind: "text",
      selectedText: String(sel),
      selectionRects: rects,
      textLocator: { kind: "dom" },
      point: pointOf(first),
      rect: first,
      elementPath: anc ? pathOf(anc) : base.elementPath,
      nearbyText: anc ? nearby(anc) : clip(String(sel), 500),
    });
  }

  // (2) a form-control selection (recovered textLocator kind
  // "form-control").
  const field = document.activeElement;
  const editable = field
    && (field.tagName === "TEXTAREA"
        || (field.tagName === "INPUT"
            && ["text", "search", "url", "tel", "password", "email", "number"].includes(field.type)));
  if (editable && field.selectionStart != null && field.selectionEnd > field.selectionStart) {
    const value = String(field.value ?? "");
    const r = rectOf(field.getBoundingClientRect());
    return JSON.stringify({
      ...base,
      kind: "text",
      selectedText: clip(value.slice(field.selectionStart, field.selectionEnd), 8000),
      selectionRects: [r],
      textLocator: { kind: "form-control" },
      point: pointOf(r),
      rect: r,
      elementPath: pathOf(field),
      selector: pathOf(field),
      role: field.tagName.toLowerCase(),
      name: clip(String(field.name ?? field.id ?? ""), 200),
      nearbyText: clip(value.replace(/\s+/g, " "), 500),
    });
  }

  // (3) nothing selected: an honest empty anchor.
  return JSON.stringify(base);
})();
"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_name_is_single_channel() {
        assert_eq!(ANNOTATION_BINDING, "__rukeAnnotationBridge");
        assert!(PAGE_RUNTIME_SCRIPT.contains("const BRIDGE = \"__rukeAnnotationBridge\""));
    }

    #[test]
    fn oai_install_grammar_is_verbatim() {
        // schemas-and-ipc §3.1: every guard and defineProperty shape the
        // recovered installer uses, pinned spelling-for-spelling.
        for needle in [
            "Reflect.get(document, \"oai\")",
            "typeof existing !== \"object\" && typeof existing !== \"function\"",
            "Reflect.get(oai, \"annotation\") != null",
            "Reflect.defineProperty(oai, \"annotation\", { configurable: true, enumerable: false, value: api })",
            "Reflect.defineProperty(document, \"oai\", { configurable: true, enumerable: false, value: oai })",
        ] {
            assert!(PAGE_RUNTIME_SCRIPT.contains(needle), "install grammar drift: {needle}");
        }
    }

    #[test]
    fn api_surface_and_event_names() {
        for needle in [
            "isActive: () => active",
            "toggle: (isActive) =>",
            "request: (spec) =>",
            "registerControls: (registration) =>",
            "codex:open-annotation",
            "site_annotation_features_changed",
            "\"Invalid annotation request\"",
            "\"Invalid annotation controls registration\"",
            "\"Annotation controls require element targets\"",
            "targets.map((_, index) => String(index + 1))",
            "bubbles: true, cancelable: true, composed: true",
            "enterAnnotationMode",
            "initialComment",
            "rangeText",
            "return { accepted }",
        ] {
            assert!(
                PAGE_RUNTIME_SCRIPT.contains(needle),
                "page API surface drift: {needle}"
            );
        }
    }

    #[test]
    fn dom_contract_names_are_verbatim() {
        // annotation-and-ui §3.2/§4 — the published contract strings.
        for needle in [
            "data-codex-browser-design-group",
            "data-browser-comment-cursor-style",
            "codex-browser-text-selection",
            "data-browser-comment-text-selection-mirror",
            "codex-browser-sidebar-comments-root",
            "data-browser-comment-interaction-blocker",
            "data-browser-comment-interaction-layer",
            "data-codex-browser-design-original-text",
            "codex-browser-design-draft-style",
            "--browser-sidebar-overlay-size-scale",
            "oai-annotatable",
            "oai-annotation-container",
            "oai-annotation-container-text",
            "oai-annotation-editor-default-mode",
            "oai-annotation-metadata",
            "selectable-containers",
            "registered-surface",
        ] {
            assert!(
                PAGE_RUNTIME_SCRIPT.contains(needle),
                "DOM contract drift: {needle}"
            );
        }
    }

    #[test]
    fn capture_anchor_fields_mirror_the_recovered_base() {
        // anchor base `hH` + textLocator kinds.
        for needle in [
            "\"none\"",
            "pageUrl: location.href",
            "frameUrl: null",
            "title: document.title",
            "elementPath:",
            "xPercent:",
            "isFixed: false",
            "framePath: []",
            "selectedText:",
            "selectionRects:",
            "textLocator: { kind: \"dom\" }",
            "textLocator: { kind: \"form-control\" }",
            "nearbyText:",
            "viewport:",
        ] {
            assert!(
                ANNOTATION_CAPTURE_JS.contains(needle),
                "anchor contract drift: {needle}"
            );
        }
    }

    #[test]
    fn webmcp_surface_grammar() {
        // Phase 14: the recovered `document.modelContext` bootstrap —
        // EventTarget surface, toolchange page event, host-bridge
        // change note, and the two recovered validator shapes.
        for needle in [
            "Reflect.get(document, \"modelContext\")",
            "const modelContext = new EventTarget();",
            "const WEBMCP_EVENT = \"toolchange\";",
            "const WEBMCP_REGISTRY = \"__rukeWebmcp\";",
            "modelContext.dispatchEvent(new Event(WEBMCP_EVENT));",
            "send(\"webmcp\", { count: registry.size });",
            "Reflect.defineProperty(modelContext, \"registerTool\"",
            "Reflect.defineProperty(modelContext, \"unregisterTool\"",
            "Reflect.defineProperty(document, \"modelContext\"",
            "\"Invalid WebMCP tool registration\"",
            "\"WebMCP tool requires a name\"",
            "\"WebMCP tool handler must be a function\"",
            "\"WebMCP tool inputSchema must be JSON-serializable\"",
            "registry.set(name, {",
            "registry.delete(name)",
        ] {
            assert!(
                PAGE_RUNTIME_SCRIPT.contains(needle),
                "WebMCP surface drift: {needle}"
            );
        }
    }

    #[test]
    fn webmcp_list_never_serializes_handlers() {
        for needle in [
            "window.__rukeWebmcp instanceof Map",
            "return { unavailable: true, url: location.href };",
            "return { url: location.href, tools: out };",
            "input_schema: r.inputSchema === undefined ? null : r.inputSchema,",
        ] {
            assert!(
                WEBMCP_LIST_JS.contains(needle),
                "WebMCP list drift: {needle}"
            );
        }
        assert!(
            !WEBMCP_LIST_JS.contains("r.handler"),
            "list must never touch handler refs"
        );
    }

    #[test]
    fn webmcp_invoke_js_escapes_payload_and_reports_page_failures() {
        let js = webmcp_invoke_js(
            "evil\"+tool",
            &serde_json::json!({ "q": "</script>", "n": 2 }),
        );
        // Injection floor: tool name and args cross as JSON literals.
        assert!(js.contains("\"evil\\\"+tool\""));
        assert!(js.contains("</script>")); // inside a JSON string, harmless in CDP evaluate
        assert!(js.contains("reg.handler({"));
        assert!(js.contains("\"n\":2"));
        assert!(js.contains("\"q\":\"</script>\""));
        for needle in [
            "not-registered",
            "the page registered this tool without a handler",
            "await reg.handler(",
            "return { ok: true, result: out === undefined ? null : out };",
            "return { ok: false, error: String((e && e.message) ? e.message : e) };",
        ] {
            assert!(js.contains(needle), "WebMCP invoke drift: {needle}");
        }
    }

    #[test]
    fn both_scripts_are_self_contained_iifes() {
        assert!(PAGE_RUNTIME_SCRIPT.starts_with("(() => {"));
        assert!(PAGE_RUNTIME_SCRIPT.trim_end().ends_with("})();"));
        assert!(ANNOTATION_CAPTURE_JS.starts_with("(() => {"));
        assert!(ANNOTATION_CAPTURE_JS.trim_end().ends_with("})();"));
    }
}
