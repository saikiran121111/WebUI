import type { CadEntity, CadSpec } from "./cadSchema";
import { specBBox } from "./cad2d";

/**
 * Real DXF serializer: the cad spec's entities become genuine DXF ENTITIES
 * (LINE / LWPOLYLINE / POLYLINE+VERTEX / CIRCLE / ARC / TEXT) on named CAD
 * layers (L-WALLS, L-DIM, …) with a LAYER + LTYPE table. R2000 (AC1015) uses
 * LWPOLYLINE + true color; R12 (AC1009) uses POLYLINE/VERTEX/SEQEND and ACI
 * colors. No server, no libraries — pure string building.
 */

export type DxfVersion = "R12" | "R2000";

const INSUNITS: Record<CadSpec["units"], number> = { m: 6, mm: 4, cm: 2, ft: 1 };

export function dxfLayerName(id: string): string {
  const cleaned = id.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!cleaned) return "L-0";
  return cleaned.startsWith("L-") ? cleaned : `L-${cleaned}`;
}

function sanitizeText(content: string): string {
  return content.replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7E]/g, "");
}

export function cadToDxf(spec: CadSpec, opts: { version?: DxfVersion } = {}): string {
  const version = opts.version ?? "R2000";
  const out: string[] = [];
  const pair = (code: number, value: string | number) => {
    out.push(String(code), String(value));
  };

  const bbox = specBBox(spec);

  // ── HEADER ──────────────────────────────────────────────────────────────
  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$ACADVER");
  pair(1, version === "R12" ? "AC1009" : "AC1015");
  pair(9, "$INSUNITS");
  pair(70, INSUNITS[spec.units]);
  pair(9, "$EXTMIN");
  pair(10, bbox.minX);
  pair(20, bbox.minY);
  pair(30, 0);
  pair(9, "$EXTMAX");
  pair(10, bbox.maxX);
  pair(20, bbox.maxY);
  pair(30, 0);
  pair(0, "ENDSEC");

  // ── TABLES: LTYPE + LAYER ───────────────────────────────────────────────
  pair(0, "SECTION");
  pair(2, "TABLES");

  pair(0, "TABLE");
  pair(2, "LTYPE");
  pair(70, 3);
  for (const [name, pattern, length] of [
    ["Continuous", [] as number[], 0],
    ["DASHED", [-0.35, 0.35], 0.7],
    ["DOTTED", [-0.07], 0.14],
  ] as [string, number[], number][]) {
    pair(0, "LTYPE");
    pair(2, name);
    pair(70, 0);
    pair(72, 5);
    pair(73, pattern.length);
    pair(40, length);
    for (const seg of pattern) {
      pair(49, seg);
      pair(74, 0);
    }
  }
  pair(0, "ENDTAB");

  pair(0, "TABLE");
  pair(2, "LAYER");
  pair(70, spec.layers.length);
  for (const layer of spec.layers) {
    pair(0, "LAYER");
    pair(2, dxfLayerName(layer.id));
    pair(70, 0);
    pair(6, layer.lineType === "dashed" ? "DASHED" : layer.lineType === "dotted" ? "DOTTED" : "Continuous");
    if (version === "R2000") {
      pair(62, 256);
      pair(420, parseInt(layer.color.slice(1), 16));
    } else {
      pair(62, 7);
    }
  }
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");

  // ── ENTITIES ────────────────────────────────────────────────────────────
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  for (const entity of spec.entities) emitEntity(entity, version, pair);
  pair(0, "ENDSEC");

  pair(0, "EOF");
  return out.join("\n");
}

type Emit = (code: number, value: string | number) => void;

function emitEntity(entity: CadEntity, version: DxfVersion, pair: Emit): void {
  const layer = dxfLayerName(entity.layer);
  switch (entity.kind) {
    case "line":
      pair(0, "LINE");
      pair(8, layer);
      pair(10, entity.from[0]);
      pair(20, entity.from[1]);
      pair(30, 0);
      pair(11, entity.to[0]);
      pair(21, entity.to[1]);
      pair(31, 0);
      return;
    case "rect": {
      const ring: [number, number][] = [
        [entity.x, entity.y],
        [entity.x + entity.w, entity.y],
        [entity.x + entity.w, entity.y + entity.h],
        [entity.x, entity.y + entity.h],
      ];
      emitPolyline(ring, true, layer, version, pair);
      return;
    }
    case "polyline":
      emitPolyline(entity.points, entity.closed, layer, version, pair);
      return;
    case "polygon":
      emitPolyline(entity.points, true, layer, version, pair);
      return;
    case "circle":
      pair(0, "CIRCLE");
      pair(8, layer);
      pair(10, entity.cx);
      pair(20, entity.cy);
      pair(30, 0);
      pair(40, entity.r);
      return;
    case "arc":
      pair(0, "ARC");
      pair(8, layer);
      pair(10, entity.cx);
      pair(20, entity.cy);
      pair(30, 0);
      pair(40, entity.r);
      pair(50, entity.startDeg);
      pair(51, entity.endDeg);
      return;
    case "text":
      pair(0, "TEXT");
      pair(8, layer);
      pair(10, entity.x);
      pair(20, entity.y);
      pair(30, 0);
      pair(40, entity.height);
      if (entity.rotation !== 0) pair(50, entity.rotation);
      if (entity.anchor !== "start") {
        pair(72, entity.anchor === "middle" ? 1 : 2);
        pair(11, entity.x);
        pair(21, entity.y);
        pair(31, 0);
      }
      pair(1, sanitizeText(entity.content));
      return;
  }
}

function emitPolyline(points: readonly (readonly [number, number])[], closed: boolean, layer: string, version: DxfVersion, pair: Emit): void {
  if (version === "R2000") {
    pair(0, "LWPOLYLINE");
    pair(8, layer);
    pair(90, points.length);
    pair(70, closed ? 1 : 0);
    for (const [x, y] of points) {
      pair(10, x);
      pair(20, y);
    }
    return;
  }
  pair(0, "POLYLINE");
  pair(8, layer);
  pair(66, 1);
  pair(70, closed ? 1 : 0);
  for (const [x, y] of points) {
    pair(0, "VERTEX");
    pair(8, layer);
    pair(10, x);
    pair(20, y);
    pair(30, 0);
  }
  pair(0, "SEQEND");
}
