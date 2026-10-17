/**
 * Studio environment presets for the ThreeStudioViewer. Each preset builds a
 * tiny procedural scene (gradient room + emissive props) and bakes it to a
 * PMREM env map — no external HDR files, works offline, and the reflections
 * respond to the preset the user picks in the right dock.
 */

export const ENV_PRESETS = [
  "studio-soft",
  "cyberpunk-neon",
  "sunset-gold",
  "showroom-white",
  "deep-space",
  "night",
] as const;

export type EnvPreset = (typeof ENV_PRESETS)[number];

const ENV_INTENSITY: Record<EnvPreset, number> = {
  "studio-soft": 0.9,
  "cyberpunk-neon": 0.75,
  "sunset-gold": 0.85,
  "showroom-white": 1.25,
  "deep-space": 0.3,
  "night": 0.4,
};

export function envPresetIntensity(preset: EnvPreset): number {
  return ENV_INTENSITY[preset];
}

/** Gradient box room: vertex colors blend `bottom` → `top` over the height. */
function gradientRoom(three: any, topHex: string, bottomHex: string, floorHex: string | null): any {
  const scene = new three.Scene();
  const geo = new three.BoxGeometry(24, 14, 24);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new three.Color(topHex);
  const bottom = new three.Color(bottomHex);
  const floor = floorHex ? new three.Color(floorHex) : null;
  const tmp = new three.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const t = Math.min(1, Math.max(0, (y + 7) / 14));
    tmp.lerpColors(bottom, top, t);
    if (floor && y < -6.5) tmp.copy(floor);
    tmp.toArray(colors, i * 3);
  }
  geo.setAttribute("color", new three.BufferAttribute(colors, 3));
  scene.add(new three.Mesh(geo, new three.MeshBasicMaterial({ vertexColors: true, side: three.BackSide })));
  return scene;
}

function addDisc(three: any, scene: any, radius: number, color: string, x: number, y: number, z: number): void {
  const mesh = new three.Mesh(
    new three.CircleGeometry(radius, 24),
    new three.MeshBasicMaterial({ color, side: three.DoubleSide }),
  );
  mesh.position.set(x, y, z);
  mesh.lookAt(0, 0, 0);
  scene.add(mesh);
}

function addStrip(three: any, scene: any, color: string, w: number, h: number, x: number, y: number, z: number): void {
  const mesh = new three.Mesh(
    new three.PlaneGeometry(w, h),
    new three.MeshBasicMaterial({ color, side: three.DoubleSide }),
  );
  mesh.position.set(x, y, z);
  mesh.lookAt(0, 0, 0);
  scene.add(mesh);
}

/** Builds the (disposable) source scene for PMREM baking of a preset. */
export function buildEnvScene(three: any, preset: EnvPreset): any {
  switch (preset) {
    case "cyberpunk-neon": {
      const scene = gradientRoom(three, "#12081f", "#05030a", "#0a0614");
      addStrip(three, scene, "#ff2d95", 1.2, 8, -9, 0, -7);
      addStrip(three, scene, "#22d3ee", 1.2, 9, 9, 1, -5);
      addStrip(three, scene, "#7c3aed", 10, 1.5, 0, -6, 9);
      addDisc(three, scene, 1.4, "#f0abfc", 4, 5, -9);
      return scene;
    }
    case "sunset-gold": {
      const scene = gradientRoom(three, "#241436", "#ff7a3c", "#3a1d24");
      addDisc(three, scene, 2.2, "#ffc46b", 7, -2.5, -8);
      addStrip(three, scene, "#ff9a5c", 16, 2, 0, -5.5, -9);
      return scene;
    }
    case "showroom-white": {
      const scene = gradientRoom(three, "#ffffff", "#dfe3ea", "#f4f6fa");
      const ceiling = new three.Mesh(
        new three.PlaneGeometry(20, 20),
        new three.MeshBasicMaterial({ color: "#ffffff", side: three.DoubleSide }),
      );
      ceiling.position.set(0, 6.5, 0);
      ceiling.rotation.x = Math.PI / 2;
      scene.add(ceiling);
      return scene;
    }
    case "deep-space": {
      const scene = gradientRoom(three, "#010208", "#02030a", "#010205");
      addDisc(three, scene, 0.5, "#3b82f6", -8, 4, -8);
      addDisc(three, scene, 0.25, "#e2e8f0", 6, 6, -6);
      return scene;
    }
    case "night": {
      const scene = gradientRoom(three, "#04070f", "#0b1a33", "#060b16");
      addDisc(three, scene, 1.1, "#cfe0ff", -5, 5, -8);
      addStrip(three, scene, "#12305c", 14, 1.5, 0, -6, 8);
      return scene;
    }
    case "studio-soft":
    default: {
      // Neutral soft studio: light gray gradient room with a bright ceiling.
      const scene = gradientRoom(three, "#e8ecf2", "#9aa3b0", "#c7cdd8");
      const ceiling = new three.Mesh(
        new three.PlaneGeometry(16, 16),
        new three.MeshBasicMaterial({ color: "#ffffff", side: three.DoubleSide }),
      );
      ceiling.position.set(0, 6.5, 0);
      ceiling.rotation.x = Math.PI / 2;
      scene.add(ceiling);
      return scene;
    }
  }
}

function disposeSceneDeep(scene: any): void {
  scene.traverse?.((o: any) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

/**
 * Bakes a preset to a PMREM cube texture. Returns the texture + the env
 * intensity the viewer should apply; caller owns disposal of the texture.
 */
export function buildStudioEnvironment(
  three: any,
  renderer: any,
  preset: EnvPreset,
): { texture: any; intensity: number } {
  const pmrem = new three.PMREMGenerator(renderer);
  const envScene = buildEnvScene(three, preset);
  const texture = pmrem.fromScene(envScene, 0.04).texture;
  disposeSceneDeep(envScene);
  pmrem.dispose();
  return { texture, intensity: ENV_INTENSITY[preset] };
}
