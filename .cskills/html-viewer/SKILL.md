---
name: html-viewer
description: Build self-contained interactive HTML artifacts rendered live in the dark HtmlArtifactViewer — calculators, splitters, simulators, animated explainers, live dashboards. Framer Motion 60fps rules, zero layout shift, pass-through interactivity. Extends frontend-design + web-artifacts-builder + d3-js-visualization.
---

# HTML Artifact Viewer Skill (composite core skill)

You are producing ONE interactive HTML artifact that the WebUI renders inside a
minimal dark `<HtmlArtifactViewer />` (sandboxed iframe, auto-sized by a
ResizeObserver that posts `{type:"HTML_VIEWER_RESIZE",width,height}` to the
parent). The viewer has ZERO chrome — no toolbar, no code toggle, no icons.
Everything the user needs must live inside your HTML itself.

## Output contract (MANDATORY)

One short intro sentence, then exactly ONE fenced block:

```html
<!doctype html> ... complete self-contained document ...
```

- The fence language MUST be `html`. Never emit a second fence, never paste the
  code again in prose — the block IS the product.
- Fully self-contained: inline `<style>`, inline `<script>`, inline SVG. No
  build step, no module imports, no server calls. CDN ESM imports are allowed
  ONLY for animation/chart libs (framer-motion, d3) and must degrade
  gracefully if offline (feature-detect, fall back to CSS).

## Dark aesthetic (MANDATORY — matches the viewer chrome)

- Page background: `#000000` (the viewer box is `#000000`; never paint a light
  page). Card surfaces: `#0D0D0D`–`#141414` with `1px solid #262626` borders,
  12–16px radius.
- Text: `#FFFFFF` primary, `#A1A1AA` secondary. Semantic accents:
  emerald `#22C55E` for positive/success, cyan `#38E8FF` for highlights/
  focus/active, red `#EF4444` for negative.
- `body { margin:0; }` — the viewer already provides the frame and padding.

## Sizing (the ResizeObserver contract)

- Design for a fluid width: `width:100%`, content max-width ~720–960px
  centered. NEVER hardcode a fixed pixel height on `html`/`body` — the viewer
  animates its own height to your natural content height; a fixed height
  breaks the fit animation.
- Keep the natural height stable across interactions (zero layout shift /
  CLS): reserve space for results, use `min-height` on result zones, animate
  `transform`/`opacity` — never `height`/`width`/`top`/`left` of layout boxes.

## 60fps animation rules (MANDATORY)

- Prefer Framer Motion via ESM CDN (`import { motion } from
  "https://esm.sh/framer-motion@11"`) for springs/gestures; otherwise use
  hardware-accelerated CSS: `transition: transform .35s cubic-bezier(.34,1.56,.64,1)`
  (spring-like overshoot), `will-change: transform` on animated elements.
- Animate ONLY `transform` and `opacity` (compositor-only). Never animate
  `width`, `height`, `margin`, `top`, `left`.
- Count-up numbers: rAF tween (`requestAnimationFrame`), not `setInterval`.
- Charts: inline SVG (crisp, instant) or D3; transitions via `transform`/
  `stroke-dashoffset`, target 60fps.

## Interactivity rules

- Every control must be keyboard-accessible (real `<button>`/`<input>`,
  visible `:focus-visible` ring in `#38E8FF`).
- State lives in JS; update the DOM in one pass. Inputs must reflect state
  immediately (no debounce on numeric inputs).
- The artifact receives real mouse/keyboard events (pass-through iframe) —
  hover states, drag, focus all work at 60fps.

## Use-case playbook

- Calculators / splitters / simulators: inputs on top, live result card below,
  breakdown table; validate inputs, show `#EF4444` hint, never NaN on screen.
- Animated explainers: step chips + play/pause, each step animates in with a
  spring, diagram via inline SVG.
- Mini dashboards: KPI cards with count-up + sparkline, click a bar/segment to
  cross-filter the rest.
