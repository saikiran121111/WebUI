// Self-contained live layer for Anatomy figures: drives part motion, needles,
// readouts and controls from ONE state model (the values shown are the values
// that move the drawing). Deliberately dependency-free plain JS so the exact
// same source can be inlined into standalone HTML exports (see the export
// route) and mounted inside the React app.

const RADIANS = Math.PI / 180;
const UNIT = Math.sqrt(1.6); // matches iso-kit's projection unit
const STILLNESS = "(prefers-reduced-motion: reduce)";
const LONGEST_FRAME = 1 / 30;
const EASE_SECONDS = 0.12;
const EXPLODE_SECONDS = 0.3;

const round1 = (value) => {
  const text = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return text === "-0" ? "0" : text;
};

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
 * @returns {{ setState: (id: string, value: number) => void, setExplode: (on: boolean) => void, destroy: () => void }}
 */
export function mountAnatomyLive(root, spec, hooks = {}) {
  const cam = cameraOf(spec.camera);
  const origin = spec.camera.origin;
  const readoutSlot = root.querySelector("[data-readout]");
  const defaultReadout = readoutSlot?.textContent ?? "";

  const state = new Map(); // control id -> { target, current, min, max, kind }
  for (const control of spec.controls ?? []) {
    state.set(control.id, {
      target: control.kind === "toggle" ? (control.value ? 1 : 0) : control.value,
      current: control.kind === "toggle" ? (control.value ? 1 : 0) : control.value,
      min: control.min ?? 0,
      max: control.max ?? 1,
      kind: control.kind,
    });
  }

  const groups = new Map();
  for (const part of spec.parts ?? []) {
    const node = root.querySelector(`[data-part="${part.id}"]`);
    if (node) groups.set(part.id, node);
  }

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

  let explodeTarget = spec.explode ? 1 : 0;
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
    for (const entry of state.values()) {
      const next = follow(entry.current, entry.target, dt, EASE_SECONDS, calm);
      if (next !== entry.current) more = true;
      entry.current = next;
    }
    const explodeNext = follow(explodeShare, explodeTarget, dt, EXPLODE_SECONDS, calm);
    if (explodeNext !== explodeShare) more = true;
    explodeShare = explodeNext;
    const oscillating = applyParts(dt, calm);
    applyReadouts();
    more = more || oscillating;
    frame = more && !disposed && inView ? requestAnimationFrame(step) : 0;
  };

  const kick = () => {
    if (frame || disposed || !inView) return;
    last = 0;
    frame = requestAnimationFrame(step);
  };

  // Controls: the engine owns the control DOM so the app and the standalone
  // export behave identically from the same spec.
  const controlRoot = root.querySelector("[data-anatomy-controls]");
  const controlCleanups = [];
  if (controlRoot && (spec.controls ?? []).length) {
    for (const control of spec.controls) {
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
        controlRoot.appendChild(row);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "anatomy-toggle";
        button.textContent = control.label;
        button.setAttribute("aria-pressed", String(Boolean(control.value)));
        const onClick = () => {
          const entry = state.get(control.id);
          if (!entry) return;
          const on = button.getAttribute("aria-pressed") !== "true";
          button.setAttribute("aria-pressed", String(on));
          entry.target = on ? 1 : 0;
          kick();
        };
        button.addEventListener("click", onClick);
        controlCleanups.push(() => button.removeEventListener("click", onClick));
        controlRoot.appendChild(button);
      }
    }
  }

  // Hover notes go to the plate readout corner; click hands off to the app.
  const onPointerOver = (event) => {
    const group = event.target?.closest?.("[data-part][data-note]");
    if (group && readoutSlot) readoutSlot.textContent = group.getAttribute("data-note") ?? "";
  };
  const onPointerOut = (event) => {
    const group = event.target?.closest?.("[data-part][data-note]");
    if (group && readoutSlot) readoutSlot.textContent = defaultReadout;
  };
  const onClick = (event) => {
    const group = event.target?.closest?.("[data-part]");
    if (!group || !hooks.onPartClick) return;
    hooks.onPartClick(group.getAttribute("data-part") ?? "", group.getAttribute("data-label") ?? "", group.getAttribute("data-note") ?? "");
  };
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);
  root.addEventListener("click", onClick);

  const observer = new IntersectionObserver((entries) => {
    inView = Boolean(entries.at(-1)?.isIntersecting);
    if (inView) kick();
  });
  observer.observe(root);

  applyParts(0, asksForStillness());
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
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      frame = 0;
      observer.disconnect();
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("click", onClick);
      for (const cleanup of controlCleanups) cleanup();
    },
  };
}
