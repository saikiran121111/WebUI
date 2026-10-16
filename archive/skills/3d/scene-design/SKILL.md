# Scene Design & Domain Templates

Depends on: `3d` (fence contract).

## When this runs
The request names a concrete subject: spacecraft, aircraft, vehicle, engine,
planetary system, product, character, mechanism, building, molecule.

## Composition rules

1. **Build a hierarchy, not a pile.** Root parts are children of a logical
   assembly node (`"id": "spacecraft"` group → `hull`, `propulsion`,
   `solar-arrays`, `antennas`). Use `children` for anything that moves or
   toggles together. Max nesting depth 6.
2. **Proportions come from real references.** Pick a scale unit first
   (1 unit ≈ 1 m for vehicles, ≈ 1 body radius for planets) and size every
   part against it. A Cessna-class fuselage is ~8 m long, wingspan ~11 m;
   a cubesat panel is ~0.1 m. Keep the whole subject roughly within a
   10-unit box so auto-framing works.
3. **Silhouette test.** From the default camera the object must be
   recognizable as the subject with lighting off. If it reads as random
   primitives, restructure before adding detail.
4. **Contact & mounting integrity.** Every part attaches to something:
   struts meet surfaces at their real intersection, wheels touch the ground
   plane, panels connect via yokes/brackets. No floating geometry.
5. **Ground plane**: include a `grid` object at the base for vehicles/
   products; omit grids for spacecraft/planets (space scenes).

## Domain templates (component checklists — adapt, never copy blindly)

- **Aircraft**: fuselage (lathe profile along the long axis, nose rounded,
  tail tapered), swept wings (extrude an airfoil-ish polygon, slight dihedral),
  vertical + horizontal stabilizers (extrude), engines (capsules/cylinders
  under wings or in nacelles), landing gear (strut cylinder + wheel torus/
  cylinder, gear doors optional), cockpit glazing (separate transparent
  material), propeller if turboprop (hub + 3 blades, animation channel).
- **Spacecraft**: main bus (box or lathe), propulsion (engine bell = lathe
  cone profile, nozzle rim torus), solar arrays (thin extrude panels with
  frame border + hinge yokes, deployment animation), high-gain antenna
  (lathe dish + feed rod), radiators, thruster clusters (small cones),
  starboard/port labels.
- **Vehicle**: body (extrude side profile with bevel), greenhouse/windows
  (separate transparent shell), 4 wheels (torus tire + cylinder rim,
  correct track width and wheelbase), lights (small emissive discs), bumpers.
- **Mechanical engine**: block (box with bevel), cylinders (capsules in a
  row), crankshaft (cylinder + crank webs, rotation animation), pistons
  (cylinders, position animation synced to crank via same duration),
  cam belt (torus), intake/exhaust runners (tube paths).
- **Planetary system**: sun (emissive sphere) at origin, planets on
  invisible orbit pivots (parent empty group rotated by animation), orbit
  rings (torus, thin tube), labels on each body, scale note (distances
  compressed — say so in prose).
- **Tree / nature (procedural)**: trunk (lathe, slight taper), 3–6 branch
  tubes (quadratic-ish point paths), leaf clusters (low-poly spheres or
  cones, color variation ±10%), ground disc.
- **Human/creature**: do NOT fake with primitives. Route to `asset3d`
  (asset-generation skill).

## Labels & annotations
Add `labels` for educational scenes: one short text per key part, offset
clear of the geometry. Keep ≤10 labels.

## Acceptance checklist (self-check before emitting)
- [ ] Hierarchy groups logical assemblies.
- [ ] Real-world proportions chosen and consistent.
- [ ] Every part mounted, nothing floating or intersecting by accident.
- [ ] Default camera position frames the whole subject with margin.
- [ ] Subject-specific parts present per the template above.
