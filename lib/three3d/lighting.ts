import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type LightingPreset = "studio" | "dramatic" | "blueprint" | "space";

export interface LightingRig {
  lights: any[];
  key: any;
  envIntensity: number;
}

interface PresetDef {
  ambient: number;
  env: number;
  key: { color: number; intensity: number; pos: [number, number, number] };
  fill: { color: number; intensity: number; pos: [number, number, number] };
  rim: { color: number; intensity: number; pos: [number, number, number] } | null;
  hemi: { sky: number; ground: number; intensity: number } | null;
}

const PRESETS: Record<LightingPreset, PresetDef> = {
  studio: {
    ambient: 0.45, env: 0.9,
    key: { color: 0xffffff, intensity: 2.2, pos: [5, 8, 6] },
    fill: { color: 0xbfd4ff, intensity: 0.8, pos: [-6, 4, -3] },
    rim: { color: 0xffffff, intensity: 1.4, pos: [0, 6, -9] },
    hemi: null,
  },
  dramatic: {
    ambient: 0.25, env: 0.4,
    key: { color: 0xffe0b2, intensity: 3.2, pos: [7, 5, 8] },
    fill: { color: 0x3355aa, intensity: 0.35, pos: [-7, 2, -5] },
    rim: { color: 0x88bbff, intensity: 2.2, pos: [-2, 7, -9] },
    hemi: null,
  },
  blueprint: {
    ambient: 1.0, env: 0.8,
    key: { color: 0xffffff, intensity: 1.0, pos: [4, 8, 6] },
    fill: { color: 0xc7d6ea, intensity: 0.7, pos: [-5, 3, 4] },
    rim: null,
    hemi: { sky: 0xdde7f5, ground: 0x334155, intensity: 1.1 },
  },
  space: {
    ambient: 0.12, env: 0.15,
    key: { color: 0xffffff, intensity: 3.6, pos: [12, 7, 5] },
    fill: { color: 0x223355, intensity: 0.15, pos: [-8, 2, -6] },
    rim: null,
    hemi: null,
  },
};

/** Adds the preset light rig to the scene; returns lights for disposal. */
export function applyLighting(
  three: any,
  scene: any,
  opts: { preset?: LightingPreset; shadows?: boolean; ambientIntensity?: number },
): LightingRig {
  const def = PRESETS[opts.preset ?? "studio"];
  const ambientIntensity = opts.ambientIntensity ?? def.ambient;

  const lights: any[] = [new three.AmbientLight(0xffffff, ambientIntensity)];

  const key = new three.DirectionalLight(def.key.color, def.key.intensity);
  key.position.set(...def.key.pos);
  if (opts.shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 60;
    key.shadow.camera.left = -15;
    key.shadow.camera.right = 15;
    key.shadow.camera.top = 15;
    key.shadow.camera.bottom = -15;
    key.shadow.bias = -0.0005;
  }
  lights.push(key);

  const fill = new three.DirectionalLight(def.fill.color, def.fill.intensity);
  fill.position.set(...def.fill.pos);
  lights.push(fill);

  if (def.rim) {
    const rim = new three.DirectionalLight(def.rim.color, def.rim.intensity);
    rim.position.set(...def.rim.pos);
    lights.push(rim);
  }
  if (def.hemi) {
    lights.push(new three.HemisphereLight(def.hemi.sky, def.hemi.ground, def.hemi.intensity));
  }

  scene.add(...lights);
  return { lights, key, envIntensity: def.env };
}

/**
 * Image-based lighting: PMREM-filtered RoomEnvironment gives metals and
 * glass real reflections. Call only in the browser (needs a WebGLRenderer).
 */
export function buildEnvironment(three: any, renderer: any): { pmrem: any; texture: any } {
  const pmrem = new three.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  return { pmrem, texture };
}
