import type { Scene3DMaterial } from "./sceneSchema";

/** Neutral engineering-slate default so unstyled parts still read as solids. */
const DEFAULT_COLOR = "#8B95A5";

/** Builds a PBR MeshStandardMaterial from a validated material block. */
export function buildMaterial(three: any, m?: Scene3DMaterial): any {
  const mat = new three.MeshStandardMaterial({
    color: m?.color ?? DEFAULT_COLOR,
    roughness: m?.roughness ?? 0.55,
    metalness: m?.metalness ?? 0.25,
  });
  if (m?.emissive) {
    mat.emissive = new three.Color(m.emissive);
    mat.emissiveIntensity = m.emissiveIntensity ?? 1;
  }
  if (m?.flatShading) mat.flatShading = true;
  if (m?.wireframe) mat.wireframe = true;
  if (m?.opacity != null && m.opacity < 1) {
    mat.transparent = m.transparent ?? true;
    mat.opacity = m.opacity;
  } else if (m?.transparent) {
    mat.transparent = true;
  }
  mat.side =
    m?.side === "double" ? three.DoubleSide :
    m?.side === "back" ? three.BackSide :
    three.FrontSide;
  return mat;
}
