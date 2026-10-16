import type { AnatomyFloor, AnatomyPart, AnatomySpec } from "./anatomySchema";

/**
 * Floor-module expansion for architectural scenes: a module is authored ONCE
 * (it counts once against the logical part budget) and instantiated per floor
 * that references it, shifted to that floor's z. Instance ids are
 * `${floorId}__${partId}` so selection, visibility, flows and animation stay
 * addressable per floor. Pure function — the builder, the export route and
 * the schema's rendered-part budget all see identical expansion.
 */

type Vec3 = [number, number, number];
type Vec2 = [number, number];

/** Shift a module ROOT part's world coordinates by dz. Child parts (with "on")
 *  are parent-relative and follow their parent automatically. */
function shiftPartZ(part: AnatomyPart, dz: number): AnatomyPart {
  switch (part.kind) {
    case "slab":
    case "cylinder":
    case "prism":
    case "dial":
    case "ruler":
    case "knob":
    case "screws":
      return { ...part, z: part.z + dz };
    case "rod":
      return { ...part, path: part.path.map(([x, y, z]) => [x, y, z + dz] as Vec3) };
    case "coil":
      return { ...part, center: [part.center[0], part.center[1] + dz] as Vec2 };
    case "callout":
      return { ...part, at: [part.at[0], part.at[1], part.at[2] + dz] as Vec3 };
    case "faceLabel":
      return { ...part }; // positioned through its target, which shifts with the module
  }
}

function instantiate(part: AnatomyPart, floor: AnatomyFloor, dz: number): AnatomyPart {
  const shifted = part.on ? part : shiftPartZ(part, dz);
  return {
    ...shifted,
    id: `${floor.id}__${part.id}`,
    on: part.on ? `${floor.id}__${part.on}` : undefined,
    floor: part.floor ?? floor.id,
  };
}

export function expandFloorModules(spec: AnatomySpec): AnatomyPart[] {
  const modules = new Map(spec.modules.map((mod) => [mod.id, mod]));
  const expanded: AnatomyPart[] = [...spec.parts];
  for (const floor of spec.floors) {
    if (!floor.module) continue;
    const mod = modules.get(floor.module);
    if (!mod) continue; // schema validation rejects this; stay defensive, never throw
    const dz = floor.z - mod.anchorZ;
    for (const part of mod.parts) expanded.push(instantiate(part, floor, dz));
  }
  return expanded;
}
