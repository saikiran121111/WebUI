/**
 * Provider-agnostic contract for Mode B (genuine AI-generated meshes).
 * The WebUI talks only to these shapes, so swapping Meshy for TRELLIS or a
 * local generator later means adding one adapter file — nothing else moves.
 */

export type AssetFormat = "glb" | "obj" | "fbx" | "stl" | "usdz" | "3mf";

export type AssetJobStatus = "pending" | "processing" | "succeeded" | "failed" | "canceled";

export interface AssetJobView {
  jobId: string;
  provider: string;
  status: AssetJobStatus;
  /** 0-100 across the whole pipeline (preview + refine stages). */
  progress: number;
  /**
   * Directly-downloadable artifact URLs the provider actually produced.
   * "mtl" is the OBJ material sidecar (packaged into the zip, never offered
   * as a standalone download format).
   */
  modelUrls: Partial<Record<AssetFormat | "mtl", string>>;
  /** PBR texture sidecar URLs (base_color, metallic, normal, roughness, emission). */
  textureUrls?: Array<Partial<Record<string, string>>>;
  thumbnailUrl?: string;
  /**
   * When a multi-stage pipeline finishes one stage, the server follows to
   * the next stage itself and hands the client the new job id — the client
   * just keeps polling whatever id it was last given.
   */
  nextJobId?: string;
  error?: string;
}

export interface DownloadedArtifact {
  data: Uint8Array;
  contentType: string;
  filename: string;
}
