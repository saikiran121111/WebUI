import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { disposeObject3D } from "./sceneBuilder";

/**
 * Real model exports via the official three.js GLTFExporter. Only GLB and
 * glTF are offered for procedural scenes — claiming FBX/STL/USDZ here would
 * be a lie, so the UI never shows those buttons for scene3d content.
 */
export type SceneExportFormat = "glb" | "gltf";

export const SCENE_EXPORT_FORMATS: SceneExportFormat[] = ["glb", "gltf"];

export async function exportScene(
  three: any,
  root: any,
  clips: any[],
  format: SceneExportFormat,
  filename: string,
): Promise<Blob> {
  const exporter = new GLTFExporter();
  return new Promise<Blob>((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (format === "glb") {
          resolve(new Blob([result as ArrayBuffer], { type: "model/gltf-binary" }));
        } else {
          // binary:false embeds buffers as base64 data URIs → single .gltf.
          resolve(new Blob([JSON.stringify(result, null, 2)], { type: "model/gltf+json" }));
        }
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
      {
        binary: format === "glb",
        animations: clips,
        onlyVisible: false,
        truncateDrawRange: true,
      },
    );
  });
}

/**
 * Extra real exporters for the Studio viewer, via the official three.js
 * addon exporters — each loaded on demand so they stay out of the initial
 * bundle. OBJ/STL/PLY/USDZ are all genuine client-side files, no server.
 */
export type MeshExportFormat = "obj" | "stl" | "ply" | "usdz";

export async function exportMesh(root: any, format: MeshExportFormat): Promise<Blob> {
  switch (format) {
    case "obj": {
      const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
      return new Blob([new OBJExporter().parse(root)], { type: "text/plain" });
    }
    case "stl": {
      const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
      const data: any = new STLExporter().parse(root, { binary: true });
      return new Blob([data instanceof DataView ? data.buffer : data], { type: "model/stl" });
    }
    case "ply": {
      const { PLYExporter } = await import("three/examples/jsm/exporters/PLYExporter.js");
      const text = await new Promise<string>(resolve => {
        new PLYExporter().parse(root, resolve as (s: string) => void, { binary: false });
      });
      return new Blob([text], { type: "text/plain" });
    }
    case "usdz": {
      const { USDZExporter } = await import("three/examples/jsm/exporters/USDZExporter.js");
      const buffer = await new USDZExporter().parseAsync(root);
      return new Blob([buffer], { type: "model/vnd.usdz+zip" });
    }
  }
}

/** Triggers a real browser download and revokes the object URL afterwards. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Round-trip check used by tests and by the viewer after an export:
 * re-parses the GLB header + JSON chunk and confirms the magic bytes and
 * chunk structure are what a GLB reader (Blender, three's GLTFLoader) will
 * accept. Returns the parsed glTF JSON summary.
 */
export function validateGlb(bytes: ArrayBuffer): { json: any; binByteLength: number } {
  const view = new DataView(bytes);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "glTF") throw new Error("not a GLB: missing glTF magic");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported glTF version ${version}`);
  const totalLength = view.getUint32(8, true);
  if (totalLength !== bytes.byteLength) throw new Error("GLB length header mismatch");

  let offset = 12;
  let json: any = null;
  let binByteLength = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkData = bytes.slice(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a /* "JSON */) {
      json = JSON.parse(new TextDecoder().decode(chunkData));
    } else if (chunkType === 0x004e4942 /* "BIN\0 */) {
      binByteLength = chunkLength;
    }
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, binByteLength };
}

/**
 * Re-imports exported GLB bytes with GLTFLoader (browser) and disposes the
 * test scene — proves the download is loadable, not just well-formed.
 */
export async function reimportGlb(three: any, bytes: ArrayBuffer): Promise<{ meshes: number }> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  const gltf: any = await new Promise((resolve, reject) =>
    loader.parse(bytes.slice(0), "", resolve, reject),
  );
  let meshes = 0;
  gltf.scene.traverse((o: any) => { if (o.isMesh) meshes += 1; });
  disposeObject3D(gltf.scene);
  return { meshes };
}
