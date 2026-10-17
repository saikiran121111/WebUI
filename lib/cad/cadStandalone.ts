import type { CadSpec } from "./cadSchema";

/**
 * Self-contained interactive HTML export for a cad spec: vanilla-JS SVG
 * blueprint + isometric cutaway, layer checkboxes, explode slider, wheel
 * zoom / drag pan, and a two-click measure tool. No CDN, no build step —
 * the spec is embedded as JSON and the page works offline.
 */
export function buildCadStandaloneHtml(spec: CadSpec): string {
  const payload = JSON.stringify(spec).replace(/<\//g, "<\\/");
  const title = spec.title.replace(/[<>&]/g, "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { margin: 0; background: #090d16; color: #e2e8f0; font: 13px/1.5 system-ui, sans-serif; }
  header { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid #1e293b; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0 12px 0 0; }
  button { background: #16213a; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button[aria-pressed="true"] { border-color: #38bdf8; color: #38bdf8; }
  label { display: inline-flex; gap: 5px; align-items: center; }
  #wrap { display: flex; height: calc(100vh - 52px); }
  #side { width: 210px; padding: 10px 12px; border-right: 1px solid #1e293b; overflow-y: auto; }
  #side h2 { font-size: 11px; letter-spacing: .08em; color: #64748b; margin: 8px 0 4px; }
  #stage { flex: 1; touch-action: none; cursor: crosshair; }
  #readout { padding: 4px 14px; font-variant-numeric: tabular-nums; color: #94a3b8; }
  .flow-dash { stroke-dasharray: 6 5; animation: cadflow 1.4s linear infinite; }
  @keyframes cadflow { to { stroke-dashoffset: -22; } }
  @media (prefers-reduced-motion: reduce) { .flow-dash { animation: none; } }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <button id="btn2d" aria-pressed="true">2D</button>
  <button id="btniso" aria-pressed="false">Iso</button>
  <label>Explode <input id="explode" type="range" min="0" max="100" value="0" /></label>
  <button id="measure">Measure</button>
  <button id="fit">Zoom fit</button>
  <span id="readout"></span>
</header>
<div id="wrap">
  <div id="side"><h2>LAYERS</h2><div id="layers"></div></div>
  <svg id="stage" xmlns="http://www.w3.org/2000/svg"></svg>
</div>
<script>
var SPEC = ${payload};
var layers = SPEC.layers, entities = SPEC.entities, walls = SPEC.walls, slabs = SPEC.slabs;
var hotspots = SPEC.hotspots || [], flows = SPEC.flows || [];
var allPts = [];
entities.forEach(function (e) { allPts = allPts.concat(entityPts(e)); });
walls.forEach(function (w) { allPts = allPts.concat(w.path); });
slabs.forEach(function (sl) { allPts = allPts.concat(sl.outline); });
if (!allPts.length) allPts = [[0, 0], [10, 10]];
var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
allPts.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); });
var padX = (maxX - minX) * 0.06 + 0.5, padY = (maxY - minY) * 0.06 + 0.5;
var view = { x: minX - padX, y: -(maxY + padY), w: (maxX - minX) + 2 * padX, h: (maxY - minY) + 2 * padY };
var state = { view: SPEC.defaultView === 'iso' || SPEC.defaultView === '3d' ? 'iso' : '2d', explode: 0, measure: [], measuring: false };
var vis = {};
layers.forEach(function (l) { vis[l.id] = l.visible; });
var layerById = {};
layers.forEach(function (l) { layerById[l.id] = l; });
var stage = document.getElementById('stage');
var readout = document.getElementById('readout');

function entityPts(e) {
  if (e.kind === 'line') return [e.from, e.to];
  if (e.kind === 'rect') return [[e.x, e.y], [e.x + e.w, e.y + e.h]];
  if (e.kind === 'polyline' || e.kind === 'polygon') return e.points;
  if (e.kind === 'circle' || e.kind === 'arc') return [[e.cx - e.r, e.cy - e.r], [e.cx + e.r, e.cy + e.r]];
  return [[e.x, e.y]];
}
function el(tag, attrs) {
  var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (var k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function dashFor(l) { return l && l.lineType === 'dashed' ? '0.5 0.3' : l && l.lineType === 'dotted' ? '0.12 0.2' : 'none'; }
function iso(x, y, z) { return [(x - y) * 0.8660254, (x + y) * 0.5 - z]; }
function explodeZ(z) { return z * (1 + state.explode / 100); }

function render() {
  while (stage.firstChild) stage.removeChild(stage.firstChild);
  stage.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
  if (state.view === '2d') render2d(); else renderIso();
  state.measure.forEach(function (seg) {
    var a = [seg.a[0], -seg.a[1]], b = [seg.b[0], -seg.b[1]];
    stage.appendChild(el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: '#FBBF24', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
    var t = el('text', { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 - 0.3, fill: '#FBBF24', 'font-size': 0.45, 'text-anchor': 'middle' });
    t.textContent = seg.label;
    stage.appendChild(t);
  });
}

function render2d() {
  entities.forEach(function (e) {
    var l = layerById[e.layer];
    if (!vis[e.layer]) return;
    var common = { stroke: l.color, 'stroke-width': 1.4, fill: 'none', 'vector-effect': 'non-scaling-stroke', opacity: l.opacity };
    if (dashFor(l) !== 'none') common['stroke-dasharray'] = dashFor(l);
    var node = null;
    if (e.kind === 'line') node = el('line', { x1: e.from[0], y1: -e.from[1], x2: e.to[0], y2: -e.to[1], 'stroke-width': 1.8, stroke: l.color, opacity: l.opacity, 'vector-effect': 'non-scaling-stroke' });
    else if (e.kind === 'rect') { common.x = e.x; common.y = -(e.y + e.h); common.width = e.w; common.height = e.h; if (e.filled) { common.fill = l.color; common['fill-opacity'] = 0.25; } node = el('rect', common); }
    else if (e.kind === 'polyline' || e.kind === 'polygon') {
      var pts = e.points.map(function (p) { return p[0] + ',' + (-p[1]); }).join(' ');
      node = el('polygon', Object.assign({}, common, { points: pts }));
      if (e.kind === 'polyline' && !e.closed) { node = el('polyline', common); node.setAttribute('points', pts); }
    } else if (e.kind === 'circle') { common.cx = e.cx; common.cy = -e.cy; common.r = e.r; if (e.filled) { common.fill = l.color; common['fill-opacity'] = 0.25; } node = el('circle', common); }
    else if (e.kind === 'arc') {
      var a0 = e.startDeg * Math.PI / 180, a1 = e.endDeg * Math.PI / 180;
      var x0 = e.cx + e.r * Math.cos(a0), y0 = -(e.cy + e.r * Math.sin(a0));
      var x1 = e.cx + e.r * Math.cos(a1), y1 = -(e.cy + e.r * Math.sin(a1));
      var delta = (e.endDeg - e.startDeg) % 360; if (delta < 0) delta += 360;
      node = el('path', Object.assign({}, common, { d: 'M ' + x0 + ' ' + y0 + ' A ' + e.r + ' ' + e.r + ' 0 ' + (delta > 180 ? 1 : 0) + ' 0 ' + x1 + ' ' + y1 }));
    } else if (e.kind === 'text') {
      node = el('text', { x: e.x, y: -e.y, fill: l.color, 'font-size': e.height, 'text-anchor': e.anchor === 'middle' ? 'middle' : e.anchor === 'end' ? 'end' : 'start', opacity: l.opacity });
      if (e.rotation) node.setAttribute('transform', 'rotate(' + (-e.rotation) + ' ' + e.x + ' ' + (-e.y) + ')');
      node.textContent = e.content;
    }
    if (node) stage.appendChild(node);
  });
  walls.forEach(function (w) {
    if (!vis[w.layer]) return;
    var l = layerById[w.layer];
    var pts = w.path.map(function (p) { return p[0] + ',' + (-p[1]); }).join(' ');
    stage.appendChild(el('polygon', { points: pts, fill: 'none', stroke: l.color, 'stroke-width': Math.max(2, w.thickness * 8), 'vector-effect': 'non-scaling-stroke', opacity: l.opacity }));
  });
  hotspots.forEach(function (h) {
    if (vis[(h.layer || (layers[0] && layers[0].id))]) {
      stage.appendChild(el('circle', { cx: h.x, cy: -h.y, r: 0.28, fill: '#38BDF8' }));
    }
  });
}

function renderIso() {
  var faces = [];
  walls.forEach(function (w) {
    if (!vis[w.layer]) return;
    var l = layerById[w.layer];
    var z0 = explodeZ(w.z), z1 = explodeZ(w.z) + w.height;
    for (var i = 0; i < w.path.length - 1; i++) faces.push(wallFace(w.path[i], w.path[i + 1], w.thickness, z0, z1, l.color));
    if (w.closed) faces.push(wallFace(w.path[w.path.length - 1], w.path[0], w.thickness, z0, z1, l.color));
  });
  slabs.forEach(function (sl) {
    if (!vis[sl.layer]) return;
    var l = layerById[sl.layer];
    var z = explodeZ(sl.z);
    var top = sl.outline.map(function (p) { return iso(p[0], p[1], z + sl.thickness); });
    faces.push({ depth: avgDepth(sl.outline) + z, points: top, color: l.color, shade: 1 });
  });
  faces.sort(function (a, b) { return a.depth - b.depth; });
  faces.forEach(function (face) {
    var pts = face.points.map(function (p) { return p[0] + ',' + (-p[1]); }).join(' ');
    stage.appendChild(el('polygon', { points: pts, fill: face.color, 'fill-opacity': 0.16 * face.shade, stroke: face.color, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  });
  flows.forEach(function (fl) {
    var pts = fl.points.map(function (p) { var q = iso(p[0], p[1], explodeZ(fl.z) + 0.4); return q[0] + ',' + (-q[1]); }).join(' ');
    stage.appendChild(el('polyline', { points: pts, fill: 'none', stroke: fl.color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'class': 'flow-dash' }));
  });
}

function avgDepth(pts) { var s = 0; pts.forEach(function (p) { s += p[0] + p[1]; }); return s / pts.length; }

function wallFace(a, b, t, z0, z1, color) {
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var len = Math.hypot(dx, dy) || 1;
  var nx = (-dy / len) * (t / 2), ny = (dx / len) * (t / 2);
  var c = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  var top = c.map(function (p) { return iso(p[0], p[1], z1); });
  var side = [iso(c[0][0], c[0][1], z0), iso(c[1][0], c[1][1], z0), iso(c[1][0], c[1][1], z1), iso(c[0][0], c[0][1], z1)];
  return { depth: avgDepth(c) + (z0 + z1) / 2, points: top, color: color, shade: 1, extra: side };
}

document.getElementById('btn2d').addEventListener('click', function () { setView('2d'); });
document.getElementById('btniso').addEventListener('click', function () { setView('iso'); });
function setView(v) {
  state.view = v;
  document.getElementById('btn2d').setAttribute('aria-pressed', v === '2d');
  document.getElementById('btniso').setAttribute('aria-pressed', v === 'iso');
  render();
}
document.getElementById('explode').addEventListener('input', function (e) { state.explode = Number(e.target.value); render(); });
document.getElementById('fit').addEventListener('click', function () {
  view = { x: minX - padX, y: -(maxY + padY), w: (maxX - minX) + 2 * padX, h: (maxY - minY) + 2 * padY };
  render();
});
document.getElementById('measure').addEventListener('click', function () {
  state.measuring = !state.measuring;
  state.measure = [];
  document.getElementById('measure').setAttribute('aria-pressed', state.measuring);
  readout.textContent = state.measuring ? 'Click two points to measure.' : '';
  render();
});

var layersBox = document.getElementById('layers');
layers.forEach(function (l) {
  var lab = document.createElement('label');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = l.visible;
  cb.addEventListener('change', function () { vis[l.id] = cb.checked; render(); });
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(' ' + (l.name || l.id)));
  layersBox.appendChild(lab);
});

stage.addEventListener('wheel', function (e) {
  e.preventDefault();
  var r = stage.getBoundingClientRect();
  var cx = view.x + ((e.clientX - r.left) / r.width) * view.w;
  var cy = view.y + ((e.clientY - r.top) / r.height) * view.h;
  var f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
  view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f;
  view.w *= f; view.h *= f;
  render();
});
var dragging = null;
stage.addEventListener('pointerdown', function (e) {
  if (state.measuring) {
    var p = toModel(e);
    state.measurePending = state.measurePending || [];
    state.measurePending.push(p);
    if (state.measurePending.length === 2) {
      var a = state.measurePending[0], b = state.measurePending[1];
      var d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      state.measure.push({ a: a, b: b, label: d.toFixed(2) + ' ' + (SPEC.units || 'm') });
      state.measurePending = [];
      readout.textContent = 'Distance: ' + d.toFixed(2) + ' ' + (SPEC.units || 'm');
    }
    render();
    return;
  }
  dragging = { x: e.clientX, y: e.clientY };
});
stage.addEventListener('pointermove', function (e) {
  if (!dragging) return;
  var r = stage.getBoundingClientRect();
  view.x -= ((e.clientX - dragging.x) / r.width) * view.w;
  view.y -= ((e.clientY - dragging.y) / r.height) * view.h;
  dragging = { x: e.clientX, y: e.clientY };
  render();
});
window.addEventListener('pointerup', function () { dragging = null; });
function toModel(e) {
  var r = stage.getBoundingClientRect();
  return [view.x + ((e.clientX - r.left) / r.width) * view.w, -(view.y + ((e.clientY - r.top) / r.height) * view.h)];
}
render();
</script>
</body>
</html>
`;
}
