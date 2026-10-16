// Self-contained live layer for Anatomy figures: drives part motion, needles,
// readouts, layer visibility, floor/system inspection, connection flows,
// zoom-pan and the info panel from ONE state model (the values shown are the
// values that move the drawing). Deliberately dependency-free plain JS so the
// exact same source can be inlined into standalone HTML exports (see the
// export route) and mounted inside the React app.

const RADIANS = Math.PI / 180;
const UNIT = Math.sqrt(1.6); // matches iso-kit's projection unit
const STILLNESS = "(prefers-reduced-motion: reduce)";
const LONGEST_FRAME = 1 / 30;
const EASE_SECONDS = 0.12;
const EXPLODE_SECONDS = 0.3;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD = 5; // px before a click becomes a pan

const round1 = (value) => {
  const text = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return text === "-0" ? "0" : text;
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

const asksForStillness = () => typeof window !== "undefined" && window.matchMedia(STILLNESS).matches;

function cameraOf(camera) {
  const a = (camera.azimuth ?? 45) * RADIANS;
  const e = (camera.elevation ?? 30) * RADIANS;
  return { sinA: Math.sin(a), cosA: Math.cos(a), sinE: Math.sin(e), cosE: Math.cos(e), k: camera.scale * UNIT };
}

/** Screen delta for a world offset — same math as iso-kit's axisVector. */
function screenOf([x, y, z], cam) {
  return [(x * cam.sinA - y * cam.cosA) * cam.k, ((x * cam.cosA + y * cam.sinA) * cam.sinE - z * cam.cosE) * cam.k];
}

function follow(current, target, dt, seconds, calm) {
  if (calm) return target;
  const next = current + (target - current) * (1 - Math.exp(-dt / seconds));
  return Math.abs(target - next) < 1e-3 ? target : next;
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// ── Engine chrome styles: injected once per document so the app, the
//    standalone export and the TSX component all look identical. :where()
//    keeps control chrome at zero specificity so app CSS still wins. ──

const ENGINE_STYLE_ID = "anatomy-engine-style";
const ENGINE_STYLE = `
:where(.anatomy-controls){display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
:where(.anatomy-toggle),:where(.anatomy-button),:where(.anatomy-select){font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;transition:transform .15s ease-out}
:where(.anatomy-toggle[aria-pressed="false"]){opacity:.55}
:where(.anatomy-toggle:active),:where(.anatomy-button:active){transform:scale(.96)}
:where(.anatomy-section){font-size:12px}
:where(.anatomy-section summary){cursor:pointer;opacity:.75;padding:2px 0;user-select:none}
:where(.anatomy-section-body){display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.anatomy-flow{stroke-dasharray:5 9}
.anatomy-connection,.anatomy-flow{pointer-events:none}
[data-anatomy-selected]{filter:drop-shadow(0 0 2.5px #f0a35c)}
.anatomy-info{margin-top:10px;padding:8px 10px;border:1px solid rgba(128,128,128,.35);border-radius:8px;font-size:12px;line-height:1.45}
.anatomy-info-title{font-weight:600}
.anatomy-info-meta{opacity:.6;font-size:11px;margin-left:8px}
.anatomy-info-text{margin-top:4px;opacity:.85}
.anatomy-info-refine{margin-top:8px;font:inherit;font-size:11px;padding:3px 9px;border-radius:6px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;transition:transform .15s ease-out}
.anatomy-info-refine:active{transform:scale(.96)}
`;

function ensureEngineStyle() {
  if (typeof document === "undefined" || document.getElementById(ENGINE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = ENGINE_STYLE_ID;
  style.textContent = ENGINE_STYLE;
  document.head.appendChild(style);
}

// ── Restricted formula evaluator (no eval): + - * / ( ) and whitelisted functions ──

const FUNCTIONS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sqrt: Math.sqrt,
};

function compileFormula(formula) {
  const tokens = formula.match(/[a-zA-Z_][a-zA-Z0-9_]*|[0-9]*\.?[0-9]+|[+\-*/(),]/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const eat = (expected) => {
    if (expected !== undefined && peek() !== expected) throw new Error(`expected ${expected}`);
    return tokens[at++];
  };
  const parseExpression = () => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = eat();
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      const right = parseFactor();
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };
  const parseFactor = () => {
    if (peek() === "-") {
      eat();
      return -parseFactor();
    }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const token = peek();
    if (token === "(") {
      eat("(");
      const value = parseExpression();
      eat(")");
      return value;
    }
    if (/^[0-9]/.test(token ?? "")) return Number(eat());
    const name = eat();
    if (peek() === "(") {
      eat("(");
      const args = [parseExpression()];
      while (peek() === ",") {
        eat(",");
        args.push(parseExpression());
      }
      eat(")");
      const fn = FUNCTIONS[name];
      if (!fn) throw new Error(`unknown function ${name}`);
      return fn(...args);
    }
    return { ref: name }; // marker: resolved against live state at evaluation time
  };
  const ast = parseExpression();
  if (at !== tokens.length) throw new Error("trailing tokens");
  const resolve = (node, values) => (typeof node === "object" && node.ref ? (values[node.ref] ?? 0) : node);
  // Re-walk the tree: numbers are plain, refs are markers — rebuild lazily.
  return (values) => {
    at = 0;
    const evaluate = () => {
      const walkExpression = () => {
        let value = walkTerm();
        while (peek() === "+" || peek() === "-") {
          const op = eat();
          const right = walkTerm();
          value = op === "+" ? value + right : value - right;
        }
        return value;
      };
      const walkTerm = () => {
        let value = walkFactor();
        while (peek() === "*" || peek() === "/") {
          const op = eat();
          const right = walkFactor();
          value = op === "*" ? value * right : value / right;
        }
        return value;
      };
      const walkFactor = () => {
        if (peek() === "-") {
          eat();
          return -walkFactor();
        }
        return walkPrimary();
      };
      const walkPrimary = () => {
        const token = peek();
        if (token === "(") {
          eat("(");
          const value = walkExpression();
          eat(")");
          return value;
        }
        if (/^[0-9]/.test(token ?? "")) return Number(eat());
        const name = eat();
        if (peek() === "(") {
          eat("(");
          const args = [walkExpression()];
          while (peek() === ",") {
            eat(",");
            args.push(walkExpression());
          }
          eat(")");
          return FUNCTIONS[name](...args);
        }
        return values[name] ?? 0;
      };
      const value = walkExpression();
      return Number.isFinite(value) ? value : 0;
    };
    return evaluate();
  };
}

// ── Mount ──

/**
 * @param {HTMLElement} root container holding the built plate markup
 * @param {object} spec live spec emitted by anatomyBuilder
 * @param {{ onPartClick?: (id: string, label: string, note: string) => void }} [hooks]
 *   onPartClick fires from the info panel's refine button.
 * @returns {{ setState, setExplode, setGroup, resetView, destroy }}
 */
export function mountAnatomyLive(root, spec, hooks = {}) {
  ensureEngineStyle();
  const cam = cameraOf(spec.camera);
  const origin = spec.camera.origin;
  const readoutSlot = root.querySelector("[data-readout]");
  const defaultReadout = readoutSlot?.textContent ?? "";

  const state = new Map(); // numeric control id -> { target, current, min, max, kind }
  for (const control of spec.controls ?? []) {
    if (control.kind !== "slider" && control.kind !== "toggle") continue;
    state.set(control.id, {
      target: control.kind === "toggle" ? (control.value ? 1 : 0) : control.value,
      current: control.kind === "toggle" ? (control.value ? 1 : 0) : control.value,
      min: control.min ?? 0,
      max: control.max ?? 1,
      kind: control.kind,
    });
  }

  // One visibility model for the whole scene: group toggles, boolean
  // visibility states, floor inspection and system isolation all resolve
  // through applyVisibility() — no duplicated state anywhere else.
  const groupOn = new Map((spec.groups ?? []).map((group) => [group.id, true]));
  const toggleOn = new Map();
  for (const control of spec.controls ?? []) {
    if (control.kind !== "toggle") continue;
    toggleOn.set(control.id, Boolean(control.value));
    if (control.group) groupOn.set(control.group, Boolean(control.value));
  }
  let floorSel = null;
  let systemSel = null;

  const groups = new Map();
  for (const part of spec.parts ?? []) {
    const node = root.querySelector(`[data-part="${part.id}"]`);
    if (node) groups.set(part.id, node);
  }

  const partNodes = Array.from(root.querySelectorAll("[data-part]"));
  const connectionNodes = Array.from(root.querySelectorAll("[data-connection]"));
  const flowNodes = Array.from(root.querySelectorAll("[data-flow]"));

  const applyVisibility = () => {
    for (const node of partNodes) {
      const group = node.getAttribute("data-group");
      const floor = node.getAttribute("data-floor");
      const when = node.getAttribute("data-visible-when");
      const hidden = (group && groupOn.get(group) === false) || (when && toggleOn.get(when) === false);
      node.style.display = hidden ? "none" : "";
      // Inspection dims same-kind context instead of hiding it, so ungrouped
      // core structure and other-floor parts without a floor tag stay visible.
      const dim = !hidden && ((floorSel && floor && floor !== floorSel) || (systemSel && group && group !== systemSel));
      if (dim) node.setAttribute("opacity", "0.12");
      else node.removeAttribute("opacity");
    }
    for (const node of connectionNodes) {
      const system = node.getAttribute("data-system");
      const hidden = system && groupOn.get(system) === false;
      node.style.display = hidden ? "none" : "";
      const dim = !hidden && systemSel && system && system !== systemSel;
      if (dim) node.setAttribute("opacity", "0.12");
      else node.removeAttribute("opacity");
    }
  };

  const evaluators = (spec.readouts ?? []).map((readout) => {
    let evaluate;
    try {
      evaluate = compileFormula(readout.formula);
    } catch {
      evaluate = () => NaN;
    }
    const valueNode = root.querySelector(`[data-anatomy-readout="${readout.id}"]`);
    return { readout, evaluate, valueNode };
  });

  let explodeTarget = 0;
  let explodeShare = explodeTarget;
  let time = 0;
  let frame = 0;
  let last = 0;
  let inView = true;
  let disposed = false;

  const normalized = (controlId) => {
    const entry = controlId ? state.get(controlId) : null;
    if (!entry) return null;
    return clamp01((entry.current - entry.min) / (entry.max - entry.min || 1));
  };

  const applyParts = (dt, calm) => {
    let moving = false;
    for (const part of spec.parts ?? []) {
      const node = groups.get(part.id);
      if (!node) continue;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      if (part.slide) {
        const share = part.slide.oscillate
          ? calm
            ? 0.5
            : 0.5 + 0.5 * Math.sin((time / part.slide.oscillate.period) * Math.PI * 2)
          : normalized(part.slide.state) ?? 0;
        const along = part.slide.from + (part.slide.to - part.slide.from) * share;
        if (part.slide.axis === "x") dx += along;
        else if (part.slide.axis === "y") dy += along;
        else dz += along;
        if (part.slide.oscillate && !calm) moving = true;
      }
      if (part.explode && explodeShare !== 0) {
        dx += part.explode[0] * explodeShare;
        dy += part.explode[1] * explodeShare;
        dz += part.explode[2] * explodeShare;
      }
      if (dx || dy || dz) {
        const [sx, sy] = screenOf([dx, dy, dz], cam);
        node.setAttribute("transform", `translate(${round1(sx)} ${round1(sy)})`);
      } else {
        node.removeAttribute("transform");
      }
      if (part.needle) {
        const needleNode = root.querySelector(`[data-needle="${part.id}"]`);
        if (needleNode) {
          const share = normalized(part.needle.state);
          const angle = ((part.needle.from + (part.needle.to - part.needle.from) * (share ?? 0)) * Math.PI) / 180;
          const { cx, cy, z, r, length } = part.needle;
          const tip = [cx + Math.sin(angle) * r * length, cy - Math.cos(angle) * r * length, z];
          const center = screenOf([cx, cy, z], cam);
          const tipScreen = screenOf(tip, cam);
          needleNode.setAttribute(
            "d",
            `M${round1(origin[0] + center[0])} ${round1(origin[1] + center[1])}L${round1(origin[0] + tipScreen[0])} ${round1(origin[1] + tipScreen[1])}`,
          );
        }
      }
    }
    return moving;
  };

  // Flow animation: dashes travel along each connection's own path — the
  // motion follows the schema route, never free-floating particles.
  let flowsPlaying = false;
  let flowTime = 0;
  let lastFlowOffset = null;

  const applyFlows = (calm) => {
    if (!flowNodes.length) return false;
    const offset = calm ? 0 : -(flowTime * 36);
    if (offset === lastFlowOffset) return flowsPlaying && !calm;
    lastFlowOffset = offset;
    for (const node of flowNodes) {
      const speed = Number(node.getAttribute("data-speed") || 1);
      node.setAttribute("stroke-dashoffset", String(Math.round(offset * speed * 10) / 10));
    }
    return flowsPlaying && !calm;
  };

  const applyReadouts = () => {
    const values = {};
    for (const [id, entry] of state) values[id] = entry.current;
    for (const { readout, evaluate, valueNode } of evaluators) {
      if (!valueNode) continue;
      const raw = evaluate(values);
      const text = Number.isFinite(raw) ? raw.toFixed(readout.decimals) : "—";
      if (valueNode.textContent !== text) valueNode.textContent = text;
    }
  };

  const step = (now) => {
    const dt = last ? Math.min((now - last) / 1000, LONGEST_FRAME) : 1 / 60;
    last = now;
    const calm = asksForStillness();
    let more = false;
    time += dt;
    if (flowsPlaying && !calm) flowTime += dt;
    for (const entry of state.values()) {
      const next = follow(entry.current, entry.target, dt, EASE_SECONDS, calm);
      if (next !== entry.current) more = true;
      entry.current = next;
    }
    const explodeNext = follow(explodeShare, explodeTarget, dt, EXPLODE_SECONDS, calm);
    if (explodeNext !== explodeShare) more = true;
    explodeShare = explodeNext;
    const oscillating = applyParts(dt, calm);
    const flowing = applyFlows(calm);
    applyReadouts();
    more = more || oscillating || flowing;
    frame = more && !disposed && inView ? requestAnimationFrame(step) : 0;
  };

  const kick = () => {
    if (frame || disposed || !inView) return;
    last = 0;
    frame = requestAnimationFrame(step);
  };

  // ── Viewport: zoom / pan / pinch / reset, SVG-only (no 3D library) ──

  const viewport = root.querySelector("[data-viewport]");
  const svg = root.querySelector("svg.anatomy-svg") ?? root.querySelector("svg");
  const view = { k: 1, tx: 0, ty: 0 };

  const applyView = () => {
    if (!viewport) return;
    if (view.k === 1 && view.tx === 0 && view.ty === 0) viewport.removeAttribute("transform");
    else viewport.setAttribute("transform", `translate(${round1(view.tx)} ${round1(view.ty)}) scale(${view.k.toFixed(3)})`);
  };

  const resetView = () => {
    view.k = 1;
    view.tx = 0;
    view.ty = 0;
    applyView();
  };

  const userScale = () => {
    if (!svg) return 1;
    const box = svg.viewBox?.baseVal;
    const width = box && box.width ? box.width : svg.clientWidth || 1;
    const rect = svg.getBoundingClientRect();
    return rect.width ? width / rect.width : 1;
  };

  const zoomAt = (px, py, nextK) => {
    const k = clamp(nextK, MIN_ZOOM, MAX_ZOOM);
    view.tx = px - (px - view.tx) * (k / view.k);
    view.ty = py - (py - view.ty) * (k / view.k);
    view.k = k;
    applyView();
  };

  const onWheel = (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const s = userScale();
    zoomAt((event.clientX - rect.left) * s, (event.clientY - rect.top) * s, view.k * Math.exp(-event.deltaY * 0.0015));
  };

  const pointers = new Map();
  let dragStart = null;
  let dragMoved = false;
  let pinchStart = 0;
  let pinchK = 1;

  const onPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchK = view.k;
      for (const id of pointers.keys()) svg.setPointerCapture?.(id);
    } else if (pointers.size === 1) {
      dragStart = { x: event.clientX, y: event.clientY };
      dragMoved = false;
    }
    // No capture on pointerdown: it would retarget the click event to the svg
    // and break part selection. Capture begins when a real drag begins.
  };

  const onPointerMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    const prev = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const s = userScale();
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart && distance) {
        const rect = svg.getBoundingClientRect();
        const midX = ((a.x + b.x) / 2 - rect.left) * s;
        const midY = ((a.y + b.y) / 2 - rect.top) * s;
        zoomAt(midX, midY, pinchK * (distance / pinchStart));
        dragMoved = true;
      }
      return;
    }
    if (event.pointerType !== "mouse" && Math.abs(event.clientY - (dragStart?.y ?? event.clientY)) > Math.abs(event.clientX - (dragStart?.x ?? event.clientX))) {
      return; // let vertical touch swipes scroll the chat page
    }
    view.tx += (event.clientX - prev.x) * s;
    view.ty += (event.clientY - prev.y) * s;
    if (dragStart && !dragMoved && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > DRAG_THRESHOLD) {
      dragMoved = true;
      svg.setPointerCapture?.(event.pointerId); // a real pan keeps tracking past the svg edges
    }
    applyView();
  };

  const onPointerUp = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (pointers.size === 0) dragStart = null;
  };

  // ── Selection + info panel ──

  const infoPanel = root.querySelector("[data-anatomy-info]");
  const groupLabels = new Map((spec.groups ?? []).map((group) => [group.id, group.label]));
  const floorLabels = new Map((spec.floors ?? []).map((floor) => [floor.id, floor.label]));
  let selectedNode = null;

  if (infoPanel) {
    infoPanel.innerHTML =
      '<div class="anatomy-info-head"><span class="anatomy-info-title"></span><span class="anatomy-info-meta"></span></div><div class="anatomy-info-text"></div>';
    const refine = document.createElement("button");
    refine.type = "button";
    refine.className = "anatomy-info-refine";
    refine.textContent = "Ask WebUI to refine this part";
    refine.addEventListener("click", () => {
      if (!selectedNode || !hooks.onPartClick) return;
      hooks.onPartClick(
        selectedNode.getAttribute("data-part") ?? "",
        selectedNode.getAttribute("data-label") ?? "",
        selectedNode.getAttribute("data-info") || selectedNode.getAttribute("data-note") || "",
      );
    });
    infoPanel.appendChild(refine);
  }

  const clearSelection = () => {
    if (!selectedNode) return;
    selectedNode.removeAttribute("data-anatomy-selected");
    selectedNode = null;
    if (infoPanel) infoPanel.hidden = true;
  };

  const selectPart = (node) => {
    if (selectedNode === node) return;
    clearSelection();
    selectedNode = node;
    node.setAttribute("data-anatomy-selected", "true");
    if (!infoPanel) return;
    const id = node.getAttribute("data-part") ?? "";
    const label = node.getAttribute("data-label") || id;
    const meta = [groupLabels.get(node.getAttribute("data-group")) ?? "", floorLabels.get(node.getAttribute("data-floor")) ?? ""]
      .filter(Boolean)
      .join(" · ");
    const text = node.getAttribute("data-info") || node.getAttribute("data-note") || "";
    infoPanel.querySelector(".anatomy-info-title").textContent = label;
    infoPanel.querySelector(".anatomy-info-meta").textContent = meta;
    infoPanel.querySelector(".anatomy-info-text").textContent = text;
    infoPanel.hidden = false;
  };

  // ── Controls: the engine owns the control DOM so the app and the
  //    standalone export behave identically from the same spec. ──

  const controlRoot = root.querySelector("[data-anatomy-controls]");
  const controlCleanups = [];

  const addButton = (parent, control) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "anatomy-button";
    button.textContent = control.label;
    button.dataset.anatomyAction = control.action ?? "";
    const onClickAction = () => {
      switch (control.action) {
        case "explode":
          explodeTarget = 1;
          kick();
          break;
        case "restore":
          explodeTarget = 0;
          kick();
          break;
        case "play":
          flowsPlaying = true;
          kick();
          break;
        case "pause":
          flowsPlaying = false;
          break;
        case "reset":
          flowsPlaying = false;
          flowTime = 0;
          explodeTarget = 0;
          resetView();
          kick();
          break;
        case "resetView":
          resetView();
          break;
      }
    };
    button.addEventListener("click", onClickAction);
    controlCleanups.push(() => button.removeEventListener("click", onClickAction));
    parent.appendChild(button);
  };

  const addToggle = (parent, control) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "anatomy-toggle";
    button.textContent = control.label;
    button.dataset.anatomyControl = control.id;
    button.setAttribute("aria-pressed", String(Boolean(control.value)));
    const onClick = () => {
      const on = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(on));
      const entry = state.get(control.id);
      if (entry) entry.target = on ? 1 : 0;
      toggleOn.set(control.id, on);
      if (control.group) groupOn.set(control.group, on);
      applyVisibility();
      kick();
    };
    button.addEventListener("click", onClick);
    controlCleanups.push(() => button.removeEventListener("click", onClick));
    parent.appendChild(button);
  };

  const addSelect = (parent, control) => {
    const select = document.createElement("select");
    select.className = "anatomy-select";
    select.dataset.anatomyControl = control.id;
    select.setAttribute("aria-label", control.label);
    const options =
      control.options ??
      (control.target === "floor"
        ? [{ value: "", label: "All floors" }, ...(spec.floors ?? []).map((floor) => ({ value: floor.id, label: floor.label }))]
        : [{ value: "", label: "All systems" }, ...(spec.groups ?? []).map((group) => ({ value: group.id, label: group.label }))]);
    for (const option of options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    }
    select.value = control.value ?? "";
    const onChange = () => {
      const value = select.value || null;
      if (control.target === "floor") floorSel = value;
      else systemSel = value;
      applyVisibility();
    };
    select.addEventListener("change", onChange);
    controlCleanups.push(() => select.removeEventListener("change", onChange));
    parent.appendChild(select);
  };

  if (controlRoot && (spec.controls ?? []).length) {
    const sections = new Map(); // section name -> <details> body
    for (const control of spec.controls) {
      let parent = controlRoot;
      if (control.kind === "toggle") {
        const group = (spec.groups ?? []).find((entry) => entry.id === control.group);
        if (group?.section) {
          let body = sections.get(group.section);
          if (!body) {
            const details = document.createElement("details");
            details.className = "anatomy-section";
            details.open = true; // collapsible, but grouping must not hide controls
            const summary = document.createElement("summary");
            summary.textContent = group.section;
            body = document.createElement("div");
            body.className = "anatomy-section-body";
            details.append(summary, body);
            controlRoot.appendChild(details);
            sections.set(group.section, body);
          }
          parent = body;
        }
      }
      if (control.kind === "slider") {
        const row = document.createElement("div");
        row.className = "chart-slider-row";
        const label = document.createElement("span");
        label.className = "chart-slider-label";
        label.textContent = control.label;
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(control.min);
        input.max = String(control.max);
        input.step = String(control.step);
        input.value = String(control.value);
        input.setAttribute("aria-label", control.label);
        input.dataset.anatomyControl = control.id;
        const value = document.createElement("span");
        value.className = "chart-slider-value";
        const decimals = String(control.step).includes(".") ? String(control.step).split(".")[1].length : 0;
        value.textContent = Number(control.value).toFixed(decimals);
        const onInput = () => {
          const entry = state.get(control.id);
          if (!entry) return;
          entry.target = Number(input.value);
          value.textContent = Number(input.value).toFixed(decimals);
          kick();
        };
        input.addEventListener("input", onInput);
        controlCleanups.push(() => input.removeEventListener("input", onInput));
        row.append(label, input, value);
        parent.appendChild(row);
      } else if (control.kind === "toggle") {
        addToggle(parent, control);
      } else if (control.kind === "button") {
        addButton(parent, control);
      } else if (control.kind === "select") {
        addSelect(parent, control);
      }
    }
  }

  // Hover notes go to the plate readout corner; click selects for inspection.
  const onPointerOver = (event) => {
    const group = event.target?.closest?.("[data-part][data-note]");
    if (group && readoutSlot) readoutSlot.textContent = group.getAttribute("data-note") ?? "";
  };
  const onPointerOut = (event) => {
    const group = event.target?.closest?.("[data-part][data-note]");
    if (group && readoutSlot) readoutSlot.textContent = defaultReadout;
  };
  const onClick = (event) => {
    if (dragMoved) return; // a pan gesture is never a selection
    const group = event.target?.closest?.("[data-part]");
    if (!group) {
      clearSelection();
      return;
    }
    selectPart(group);
  };
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);
  root.addEventListener("click", onClick);
  // A click anywhere else on the page clears this figure's selection.
  const onDocClick = (event) => {
    if (event.target instanceof Node && !root.contains(event.target)) clearSelection();
  };
  document.addEventListener("click", onDocClick);
  if (svg) {
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointercancel", onPointerUp);
  }

  const observer = new IntersectionObserver((entries) => {
    inView = Boolean(entries.at(-1)?.isIntersecting);
    if (inView) kick();
  });
  observer.observe(root);

  applyVisibility();
  applyParts(0, asksForStillness());
  applyFlows(asksForStillness());
  applyReadouts();
  kick();

  return {
    setState(id, value) {
      const entry = state.get(id);
      if (!entry) return;
      entry.target = value;
      kick();
    },
    setExplode(on) {
      explodeTarget = on ? 1 : 0;
      kick();
    },
    setGroup(id, on) {
      if (!groupOn.has(id)) return;
      groupOn.set(id, on);
      applyVisibility();
    },
    resetView,
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      frame = 0;
      observer.disconnect();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("click", onClick);
      document.removeEventListener("click", onDocClick);
      if (svg) {
        svg.removeEventListener("wheel", onWheel);
        svg.removeEventListener("pointerdown", onPointerDown);
        svg.removeEventListener("pointermove", onPointerMove);
        svg.removeEventListener("pointerup", onPointerUp);
        svg.removeEventListener("pointercancel", onPointerUp);
      }
      clearSelection();
      for (const cleanup of controlCleanups) cleanup();
      // The engine owns the control DOM, so it must also remove it — a
      // re-mount must never leave a second copy of every control behind.
      if (controlRoot) controlRoot.replaceChildren();
      if (infoPanel) { infoPanel.innerHTML = ""; infoPanel.hidden = true; }
    },
  };
}
