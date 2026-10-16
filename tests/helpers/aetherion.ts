// AETHERION: a programmatic 80-floor stress plate used by the vitest budget
// benchmark and the standalone-export browser test. No vitest imports here so
// both runners can share one definition.

export function slab(id: string, x: number, y: number, w: number, d: number, z: number, h: number, tone: string, extra: Record<string, unknown> = {}) {
  return { kind: "slab", id, plan: { x, y, w, d, r: 1 }, z, height: h, tone, ...extra };
}
export function cyl(id: string, cx: number, cy: number, r: number, z: number, h: number, tone: string, extra: Record<string, unknown> = {}) {
  return { kind: "cylinder", id, center: [cx, cy], r, z, height: h, tone, ...extra };
}

/** Loop-generated module furniture attached to the module's own plate. */
export function moduleFurniture(prefix: string, count: number, plateId: string, group: string) {
  const parts = [] as Record<string, unknown>[];
  for (let i = 0; i < count; i++) {
    const side = i % 4;
    const along = Math.floor(i / 4);
    const x = side === 0 ? -50 + along * 12 : side === 1 ? 50 : side === 2 ? 50 - along * 12 : -50;
    const y = side === 0 ? -34 : side === 1 ? -30 + along * 10 : side === 2 ? 34 : 30 - along * 10;
    parts.push(i % 2 === 0 ? slab(`${prefix}${i + 1}`, x, y, 6, 6, 3, 5, "base", { on: plateId, group }) : cyl(`${prefix}${i + 1}`, x, y, 3, 3, 5, "base", { on: plateId, group }));
  }
  return parts;
}

export function buildAetherionSpec(): Record<string, unknown> {
  const groups = [
    { id: "structure", label: "Structure", color: "gray", section: "Core" },
    { id: "facade", label: "Facade", color: "gray", section: "Core" },
    { id: "interior", label: "Interior", color: "violet", section: "Core" },
    { id: "hvac", label: "HVAC", color: "cyan", section: "Services" },
    { id: "electrical", label: "Electrical", color: "amber", section: "Services" },
    { id: "water", label: "Water", color: "blue", section: "Services" },
    { id: "circulation", label: "Circulation", color: "green", section: "Services" },
    { id: "landscape", label: "Landscape", color: "red", section: "Site" },
  ];

  // 80 floors, 7-unit pitch (schema coord ceiling is ±600).
  const floors = [] as Record<string, unknown>[];
  for (let i = 1; i <= 80; i++) {
    const mod = i <= 2 ? "lobby" : i === 40 || i === 41 || i === 70 || i === 71 ? "mech" : i === 80 ? "crown" : i === 50 ? "sky" : "typical";
    floors.push({ id: `f${i}`, z: (i - 1) * 7, height: 6, label: `Level ${i}`, module: mod });
  }

  const modules = [
    { id: "typical", anchorZ: 0, parts: [
      slab("t-plate", -60, -40, 120, 80, 0, 3, "structure", { group: "structure" }),
      cyl("t-office-a", -30, 15, 10, 3, 6, "base", { on: "t-plate", group: "interior" }),
      slab("t-mep", 20, 15, 20, 12, 3, 4, "base", { on: "t-plate", group: "hvac" }),
    ] },
    { id: "mech", anchorZ: 0, parts: [
      slab("m-plate", -60, -40, 120, 80, 0, 3, "structure", { group: "structure" }),
      ...moduleFurniture("m-eq", 7, "m-plate", "hvac"),
    ] },
    { id: "lobby", anchorZ: 0, parts: [
      slab("l-plate", -70, -50, 140, 100, 0, 3, "structure", { group: "structure" }),
      ...moduleFurniture("l-fit", 19, "l-plate", "interior"),
    ] },
    { id: "sky", anchorZ: 0, parts: [
      slab("s-plate", -60, -40, 120, 80, 0, 3, "structure", { group: "structure" }),
      ...moduleFurniture("s-fit", 29, "s-plate", "interior"),
    ] },
    { id: "crown", anchorZ: 0, parts: [
      slab("c-plate", -60, -40, 120, 80, 0, 3, "structure", { group: "structure" }),
      ...moduleFurniture("c-eq", 39, "c-plate", "electrical"),
    ] },
  ];

  // Tall vertical elements are split into ≤300-unit segments (schema height cap).
  const topParts = [
    slab("core-a", -12, -12, 24, 24, 0, 280, "structure", { group: "structure" }),
    slab("core-b", -12, -12, 24, 24, 280, 280, "structure", { group: "structure" }),
    slab("foundation", -80, -60, 160, 120, -6, 6, "base", { group: "structure" }),
    slab("col1a", -62, -42, 4, 4, 0, 280, "structure", { group: "facade" }),
    slab("col1b", -62, -42, 4, 4, 280, 276, "structure", { group: "facade" }),
    slab("col2a", 58, -42, 4, 4, 0, 280, "structure", { group: "facade" }),
    slab("col2b", 58, -42, 4, 4, 280, 276, "structure", { group: "facade" }),
    slab("col3a", -62, 38, 4, 4, 0, 280, "structure", { group: "facade" }),
    slab("col3b", -62, 38, 4, 4, 280, 276, "structure", { group: "facade" }),
    slab("col4a", 58, 38, 4, 4, 0, 280, "structure", { group: "facade" }),
    slab("col4b", 58, 38, 4, 4, 280, 276, "structure", { group: "facade" }),
    slab("hvac-trunk-a", -20, 0, 5, 5, 6, 274, "base", { group: "hvac" }),
    slab("hvac-trunk-b", -20, 0, 5, 5, 280, 266, "base", { group: "hvac" }),
    slab("water-riser-a", 0, 20, 4, 4, 6, 274, "base", { group: "water" }),
    slab("water-riser-b", 0, 20, 4, 4, 280, 266, "base", { group: "water" }),
    slab("energy-riser-a", 20, 0, 4, 4, 6, 274, "base", { group: "electrical" }),
    slab("energy-riser-b", 20, 0, 4, 4, 280, 266, "base", { group: "electrical" }),
    slab("chiller", -40, 20, 24, 16, 560, 10, "subject", { group: "hvac", explode: [0, 0, 40] }),
    cyl("tank", 30, -20, 9, 560, 14, "subject", { group: "water", explode: [0, 0, 40] }),
    slab("pv-array", 20, 24, 30, 18, 560, 3, "subject", { group: "electrical", visibleWhen: "tElectrical", explode: [0, 0, 50] }),
    cyl("beacon", 0, 0, 3, 560, 8, "accent", { group: "electrical", explode: [0, 0, 60] }),
    slab("plaza", -110, -90, 220, 180, -12, 3, "base", { group: "landscape" }),
  ];
  // Facade fins: repeated structural elements authored individually (117 of
  // them) so the logical budget is pushed to its ceiling.
  for (let i = 0; i < 117; i++) {
    const side = i % 4;
    const along = (i * 7) % 100;
    const x = side === 0 ? -70 + along : side === 1 ? 70 : side === 2 ? 70 - along : -70;
    const y = side === 0 ? -50 : side === 1 ? -50 + along : side === 2 ? 50 : 50 - along;
    topParts.push(slab(`fin${i + 1}`, x, y, 2, 2, (i * 11) % 540, 5, "base", { group: "facade" }));
  }

  const connections = [
    { id: "conn-hvac-a", system: "hvac", from: "chiller", to: "hvac-trunk-a", path: [[-40, 20, 566], [-20, 20, 566], [-20, 0, 560], [-20, 0, 6]] },
    { id: "conn-hvac-b", system: "hvac", from: "hvac-trunk-b", to: "core-b", path: [[-18, 0, 300], [0, 0, 300]] },
    { id: "conn-water-a", system: "water", from: "tank", to: "water-riser-a", path: [[30, -20, 566], [0, -20, 566], [0, 20, 560], [0, 20, 6]] },
    { id: "conn-water-b", system: "water", from: "water-riser-b", to: "foundation", path: [[0, 18, 120], [-20, 0, 120]] },
    { id: "conn-energy-a", system: "electrical", from: "pv-array", to: "energy-riser-a", path: [[20, 24, 562], [20, 24, 558], [20, 0, 556], [20, 0, 6]] },
    { id: "conn-energy-b", system: "electrical", from: "energy-riser-b", to: "beacon", path: [[18, 0, 400], [0, 0, 556]] },
    { id: "conn-circ-a", system: "circulation", from: "foundation", to: "core-a", path: [[-40, -30, -3], [-12, -12, 6]] },
    { id: "conn-circ-b", system: "circulation", from: "core-b", to: "chiller", path: [[-10, -10, 540], [-40, 20, 560]] },
  ];
  const flows = [
    { id: "flow-hvac-a", connection: "conn-hvac-a", speed: 1.4 },
    { id: "flow-hvac-b", connection: "conn-hvac-b", speed: 1 },
    { id: "flow-water-a", connection: "conn-water-a", speed: 1 },
    { id: "flow-water-b", connection: "conn-water-b", speed: 0.8 },
    { id: "flow-energy-a", connection: "conn-energy-a", speed: 2.2 },
    { id: "flow-energy-b", connection: "conn-energy-b", speed: 2 },
    { id: "flow-circ-a", connection: "conn-circ-a", speed: 0.7 },
    { id: "flow-circ-b", connection: "conn-circ-b", speed: 0.7 },
  ];

  const controls = [
    ...groups.map((g) => ({ id: `t${g.id[0]!.toUpperCase()}${g.id.slice(1)}`, kind: "toggle", label: g.label, value: true, group: g.id })),
    { id: "bExplode", kind: "button", label: "Explode crown", action: "explode" },
    { id: "bPlay", kind: "button", label: "Play flows", action: "play" },
    { id: "bPause", kind: "button", label: "Pause", action: "pause" },
    { id: "bReset", kind: "button", label: "Reset", action: "reset" },
    { id: "selFloor", kind: "select", label: "Inspect level", target: "floor" },
    { id: "selSystem", kind: "select", label: "Isolate system", target: "system" },
  ];

  return {
    title: "AETHERION tower stress plate",
    fig: "FIG 9",
    label: "An 80-level mixed-use tower rendered from five reusable floor modules, exercising every advanced-profile budget at its ceiling.",
    caption: "Stress benchmark: 80 floors, 5 modules, 240 logical parts, under the 700 rendered-part cap.",
    profile: "advanced",
    width: 900,
    height: 720,
    groups,
    floors,
    modules,
    parts: topParts,
    connections,
    flows,
    controls,
    readouts: [
      { id: "levels", label: "Levels", decimals: 0, formula: "80" },
      { id: "liveSystems", label: "Live systems", decimals: 0, formula: "tHvac + tWater + tElectrical + tCirculation" },
      { id: "risers", label: "Risers", decimals: 0, formula: "tHvac + tWater + tElectrical" },
      { id: "layersOn", label: "Layers on", decimals: 0, formula: "tStructure + tFacade + tInterior + tLandscape + tHvac + tElectrical + tWater + tCirculation" },
    ],
    legend: [
      { mark: "raised", label: "Structure" },
      { mark: "flat", label: "Interior fit-out" },
      { mark: "edge", label: "Facade fins" },
      { mark: "dashed", label: "HVAC route" },
      { mark: "dotted", label: "Water route" },
      { mark: "blue", label: "Water riser" },
      { mark: "green", label: "Circulation" },
      { mark: "red", label: "Landscape" },
    ],
    explode: { label: "Explode crown" },
    export: { filename: "aetherion-stress" },
  };
}
