import { z } from "zod";
import { FURNITURE_CATEGORIES } from "./cadBlocks";

/**
 * Strict contract for the ```cad fence: a 2D CAD / BIM floor plan that the
 * ArchitectureCadViewer renders as a blueprint (2D), an isometric cutaway,
 * and an extruded 3D massing model from the SAME spec. Coordinates are
 * model-space [x, y] in `units` (y-up); walls/slabs carry z + height so the
 * 2D plan drives the 3D extrusion and the vertical Explode slider.
 */

const point2d = z.tuple([z.number().finite(), z.number().finite()]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const layerRef = z.string().min(1).max(40);
const idRef = z.string().min(1).max(40);

export const CAD_BUDGETS = {
  maxLayers: 40,
  maxEntities: 900,
  maxPointsPerEntity: 400,
  maxWalls: 240,
  maxSlabs: 60,
  maxFloors: 40,
  maxHotspots: 30,
  maxFlows: 16,
  maxDoors: 60,
  maxWindows: 80,
  maxFurniture: 120,
} as const;

const layerSchema = z
  .object({
    id: layerRef,
    name: z.string().min(1).max(60).optional(),
    color: hexColor,
    lineType: z.enum(["solid", "dashed", "dotted"]).default("solid"),
    opacity: z.number().min(0.05).max(1).default(1),
    locked: z.boolean().default(false),
    visible: z.boolean().default(true),
    group: z.string().min(1).max(40).optional(),
  })
  .strict();

const lineSchema = z
  .object({ kind: z.literal("line"), layer: layerRef, from: point2d, to: point2d })
  .strict();
const rectSchema = z
  .object({
    kind: z.literal("rect"),
    layer: layerRef,
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().positive(),
    h: z.number().finite().positive(),
    filled: z.boolean().default(false),
  })
  .strict();
const polylineSchema = z
  .object({
    kind: z.literal("polyline"),
    layer: layerRef,
    points: z.array(point2d).min(2).max(CAD_BUDGETS.maxPointsPerEntity),
    closed: z.boolean().default(false),
  })
  .strict();
const polygonSchema = z
  .object({
    kind: z.literal("polygon"),
    layer: layerRef,
    points: z.array(point2d).min(3).max(CAD_BUDGETS.maxPointsPerEntity),
  })
  .strict();
const circleSchema = z
  .object({
    kind: z.literal("circle"),
    layer: layerRef,
    cx: z.number().finite(),
    cy: z.number().finite(),
    r: z.number().finite().positive(),
    filled: z.boolean().default(false),
  })
  .strict();
const arcSchema = z
  .object({
    kind: z.literal("arc"),
    layer: layerRef,
    cx: z.number().finite(),
    cy: z.number().finite(),
    r: z.number().finite().positive(),
    startDeg: z.number().finite(),
    endDeg: z.number().finite(),
  })
  .strict();
const textSchema = z
  .object({
    kind: z.literal("text"),
    layer: layerRef,
    x: z.number().finite(),
    y: z.number().finite(),
    content: z.string().min(1).max(200),
    height: z.number().positive().max(10).default(0.25),
    rotation: z.number().finite().default(0),
    anchor: z.enum(["start", "middle", "end"]).default("start"),
  })
  .strict();

const entitySchema = z.discriminatedUnion("kind", [
  lineSchema,
  rectSchema,
  polylineSchema,
  polygonSchema,
  circleSchema,
  arcSchema,
  textSchema,
]);

const wallSchema = z
  .object({
    id: idRef,
    label: z.string().min(1).max(60).optional(),
    layer: layerRef,
    path: z.array(point2d).min(2).max(200),
    height: z.number().positive().max(50).default(3),
    thickness: z.number().positive().max(5).default(0.2),
    z: z.number().finite().default(0),
    closed: z.boolean().default(false),
  })
  .strict();
const slabSchema = z
  .object({
    id: idRef,
    label: z.string().min(1).max(60).optional(),
    layer: layerRef,
    outline: z.array(point2d).min(3).max(200),
    z: z.number().finite().default(0),
    thickness: z.number().positive().max(2).default(0.2),
  })
  .strict();
const floorSchema = z
  .object({ id: idRef, label: z.string().min(1).max(60), z: z.number().finite().default(0) })
  .strict();
const hotspotSchema = z
  .object({
    id: idRef,
    x: z.number().finite(),
    y: z.number().finite(),
    title: z.string().min(1).max(80),
    role: z.string().min(1).max(80).optional(),
    material: z.string().min(1).max(80).optional(),
    dims: z.string().min(1).max(80).optional(),
    note: z.string().min(1).max(300).optional(),
    layer: layerRef.optional(),
  })
  .strict();
const flowSchema = z
  .object({
    id: idRef,
    label: z.string().min(1).max(60).optional(),
    points: z.array(point2d).min(2).max(100),
    color: hexColor,
    speed: z.number().min(0.1).max(5).default(1),
    z: z.number().finite().default(0),
  })
  .strict();
const doorSchema = z
  .object({
    id: idRef,
    layer: layerRef,
    hinge: point2d,
    width: z.number().positive().max(6).default(0.9),
    angleDeg: z.number().finite().min(-360).max(360).default(0),
    swingDeg: z.number().finite().min(-180).max(180).default(90),
    wall: idRef.optional(),
  })
  .strict();
const windowSchema = z
  .object({
    id: idRef,
    layer: layerRef,
    from: point2d,
    to: point2d,
    sillHeight: z.number().min(0).max(3).default(0.9),
    headHeight: z.number().min(0.3).max(6).default(2.4),
    mullions: z.number().int().min(0).max(12).default(1),
    wall: idRef.optional(),
  })
  .strict();
const furnitureSchema = z
  .object({
    id: idRef,
    layer: layerRef,
    category: z.enum(FURNITURE_CATEGORIES).default("generic"),
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().positive().max(20),
    h: z.number().positive().max(20),
    rotation: z.number().finite().min(-360).max(360).default(0),
    label: z.string().min(1).max(60).optional(),
    room: z.string().min(1).max(60).optional(),
  })
  .strict();
const gridTickSchema = z
  .object({ label: z.string().min(1).max(4), position: z.number().finite() })
  .strict();
const gridSchema = z
  .object({
    columns: z.array(gridTickSchema).max(30),
    rows: z.array(gridTickSchema).max(30),
  })
  .strict();
const titleBlockSchema = z
  .object({
    projectName: z.string().min(1).max(80).optional(),
    sheetTitle: z.string().min(1).max(80).optional(),
    scaleLabel: z.string().min(1).max(40).optional(),
    date: z.string().min(1).max(40).optional(),
    author: z.string().min(1).max(60).optional(),
    sheetNumber: z.string().min(1).max(20).optional(),
    legendNote: z.string().min(1).max(200).optional(),
  })
  .strict();
const sunSchema = z
  .object({
    enabled: z.boolean().default(true),
    time: z.number().min(0).max(24).default(13),
  })
  .strict();
const exportSchema = z
  .object({
    filename: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .max(60)
      .optional(),
  })
  .strict();

export const cadSpecSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(600).optional(),
    units: z.enum(["m", "mm", "cm", "ft"]).default("m"),
    scale: z
      .object({ ratio: z.number().int().min(1).max(10000).default(100) })
      .strict()
      .optional(),
    layers: z.array(layerSchema).min(1).max(CAD_BUDGETS.maxLayers),
    entities: z.array(entitySchema).max(CAD_BUDGETS.maxEntities).default([]),
    walls: z.array(wallSchema).max(CAD_BUDGETS.maxWalls).default([]),
    slabs: z.array(slabSchema).max(CAD_BUDGETS.maxSlabs).default([]),
    floors: z.array(floorSchema).max(CAD_BUDGETS.maxFloors).default([]),
    hotspots: z.array(hotspotSchema).max(CAD_BUDGETS.maxHotspots).default([]),
    flows: z.array(flowSchema).max(CAD_BUDGETS.maxFlows).default([]),
    doors: z.array(doorSchema).max(CAD_BUDGETS.maxDoors).default([]),
    windows: z.array(windowSchema).max(CAD_BUDGETS.maxWindows).default([]),
    furniture: z.array(furnitureSchema).max(CAD_BUDGETS.maxFurniture).default([]),
    grid: gridSchema.optional(),
    titleBlock: titleBlockSchema.optional(),
    defaultView: z.enum(["2d", "iso", "3d", "split"]).default("2d"),
    sun: sunSchema.optional(),
    export: exportSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const layerIds = new Set<string>();
    spec.layers.forEach((layer, i) => {
      if (layerIds.has(layer.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", i, "id"],
          message: `duplicate layer id "${layer.id}"`,
        });
      }
      layerIds.add(layer.id);
    });

    const requireLayer = (id: string | undefined, path: (string | number)[], what: string) => {
      if (id !== undefined && !layerIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${what} references unknown layer "${id}"`,
        });
      }
    };
    spec.entities.forEach((entity, i) =>
      requireLayer(entity.layer, ["entities", i, "layer"], `entity "${entity.kind}"`),
    );
    spec.walls.forEach((wall, i) => requireLayer(wall.layer, ["walls", i, "layer"], `wall "${wall.id}"`));
    spec.slabs.forEach((slab, i) => requireLayer(slab.layer, ["slabs", i, "layer"], `slab "${slab.id}"`));
    spec.hotspots.forEach((hotspot, i) =>
      requireLayer(hotspot.layer, ["hotspots", i, "layer"], `hotspot "${hotspot.id}"`),
    );
    spec.doors.forEach((door, i) => requireLayer(door.layer, ["doors", i, "layer"], `door "${door.id}"`));
    spec.windows.forEach((win, i) => requireLayer(win.layer, ["windows", i, "layer"], `window "${win.id}"`));
    spec.furniture.forEach((f, i) =>
      requireLayer(f.layer, ["furniture", i, "layer"], `furniture "${f.id}"`),
    );

    for (const group of ["walls", "slabs", "floors", "hotspots", "flows", "doors", "windows", "furniture"] as const) {
      const seen = new Set<string>();
      spec[group].forEach((item, i) => {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [group, i, "id"],
            message: `duplicate ${group} id "${item.id}"`,
          });
        }
        seen.add(item.id);
      });
    }
  });

export type CadSpec = z.infer<typeof cadSpecSchema>;
export type CadLayer = CadSpec["layers"][number];
export type CadEntity = CadSpec["entities"][number];
export type CadWall = CadSpec["walls"][number];
export type CadSlab = CadSpec["slabs"][number];
export type CadHotspot = CadSpec["hotspots"][number];
export type CadFlow = CadSpec["flows"][number];
export type CadDoor = CadSpec["doors"][number];
export type CadWindow = CadSpec["windows"][number];
export type CadFurniture = CadSpec["furniture"][number];
export type CadGrid = NonNullable<CadSpec["grid"]>;
export type { FurnitureCategory } from "./cadBlocks";
