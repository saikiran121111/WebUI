/**
 * Meshy v2 adapter (text-to-3d). Server-only: the API key lives in the
 * server environment (MESHY_API_KEY) and is never sent to the browser —
 * the browser only ever sees opaque job ids and our own /api/3d routes.
 *
 * Two-stage pipeline for genuine quality: a fast preview task, then an
 * automatic refine task (enable_pbr) that adds real PBR textures. The
 * stage lives inside the job id ("meshy:pv:<task>" / "meshy:rf:<task>")
 * so the server can follow the pipeline without storing any state.
 */
import type { Asset3DSpec } from "../sceneSchema";
import { buildStoreZip } from "../zipWriter";
import type { AssetFormat, AssetJobStatus, AssetJobView, DownloadedArtifact } from "./types";

const BASE = "https://api.meshy.ai/openapi/v2";

export const MESHY_FORMATS: AssetFormat[] = ["glb", "obj", "fbx", "stl", "usdz", "3mf"];

export function isMeshyConfigured(): boolean {
  return Boolean(process.env.MESHY_API_KEY);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.MESHY_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function meshyFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let message = `Meshy request failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      const detail = body?.task_error?.message ?? body?.message ?? body?.error;
      if (detail) message = `${message}: ${detail}`;
    } catch { /* keep the status-only message */ }
    if (res.status === 401) message = "Meshy rejected the API key (HTTP 401)";
    if (res.status === 402) message = "Meshy account is out of credits (HTTP 402)";
    if (res.status === 429) message = "Meshy rate limit reached (HTTP 429)";
    throw new Error(message);
  }
  return res.json();
}

/* ── job id scheme: meshy:<stage>:<task id> ────────────────────────────── */

function parseJobId(jobId: string): { stage: "pv" | "rf"; taskId: string } | null {
  const match = /^meshy:(pv|rf):([A-Za-z0-9_-]{4,80})$/.exec(jobId);
  if (!match) return null;
  return { stage: match[1] as "pv" | "rf", taskId: match[2] };
}

function endpointFor(stage: "pv" | "rf"): string {
  return stage === "rf" ? "/refine-text-to-3d" : "/text-to-3d";
}

function mapStatus(raw: string): AssetJobStatus {
  switch (raw) {
    case "PENDING": return "pending";
    case "IN_PROGRESS": return "processing";
    case "SUCCEEDED": return "succeeded";
    case "FAILED": return "failed";
    case "CANCELED": return "canceled";
    default: return "processing";
  }
}

function previewBody(spec: Asset3DSpec) {
  return {
    mode: "preview",
    prompt: spec.prompt,
    target_formats: spec.formats?.length ? spec.formats : ["glb"],
    target_polycount: spec.quality === "detailed" ? 100000 : 30000,
    geometry_resolution: spec.quality === "detailed" ? "2k" : "standard",
  };
}

export async function createPreviewJob(spec: Asset3DSpec): Promise<string> {
  const data = await meshyFetch("/text-to-3d", {
    method: "POST",
    body: JSON.stringify(previewBody(spec)),
  });
  if (!data?.result) throw new Error("Meshy returned no task id");
  return `meshy:pv:${data.result}`;
}

/**
 * Poll a job. `autoRefine` (default true) starts the PBR refine stage when a
 * preview succeeds; the download route must pass `autoRefine: false` so that
 * downloading a preview-stage asset never spawns a fresh refine task.
 */
export async function pollJob(jobId: string, opts: { autoRefine?: boolean } = {}): Promise<AssetJobView> {
  const parsed = parseJobId(jobId);
  if (!parsed) throw new Error(`unknown asset job id "${jobId}"`);

  const data = await meshyFetch(`${endpointFor(parsed.stage)}/${parsed.taskId}`);
  const status = mapStatus(data.status ?? "");
  const view: AssetJobView = {
    jobId,
    provider: "meshy",
    status,
    progress: typeof data.progress === "number" ? Math.min(100, Math.max(0, data.progress)) : 0,
    modelUrls: data.model_urls ?? {},
    textureUrls: Array.isArray(data.texture_urls) ? data.texture_urls : undefined,
    thumbnailUrl: data.thumbnail_url ?? undefined,
  };
  if (data.task_error?.message) view.error = data.task_error.message;

  // Preview finished → start the refine stage (real PBR textures) and hand
  // the client the next job id. If refine cannot start, the preview result
  // is still delivered honestly rather than failing the whole job.
  if (opts.autoRefine !== false && parsed.stage === "pv" && status === "succeeded") {
    try {
      const specFormats = (Object.keys(view.modelUrls) as AssetFormat[]).filter(f => MESHY_FORMATS.includes(f));
      const refine = await meshyFetch(`/refine-text-to-3d/${parsed.taskId}`, {
        method: "POST",
        body: JSON.stringify({
          enable_pbr: true,
          texture_resolution: "2k",
          target_formats: specFormats.length ? specFormats : ["glb"],
        }),
      });
      if (refine?.result) view.nextJobId = `meshy:rf:${refine.result}`;
    } catch (err) {
      view.error = `Refine stage unavailable (${err instanceof Error ? err.message : "unknown error"}); showing the untextured preview mesh instead.`;
    }
  }
  return view;
}

export async function cancelJob(jobId: string): Promise<void> {
  const parsed = parseJobId(jobId);
  if (!parsed) throw new Error(`unknown asset job id "${jobId}"`);
  await meshyFetch(`${endpointFor(parsed.stage)}/${parsed.taskId}`, { method: "DELETE" });
}

/* ── artifact download & sidecar packaging ─────────────────────────────── */

const CONTENT_TYPES: Record<AssetFormat | "gltf", string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  fbx: "application/octet-stream",
  stl: "model/stl",
  usdz: "model/vnd.usdz+zip",
  "3mf": "model/3mf",
};

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`artifact fetch failed (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** "base_color" / "BaseColor.png" / "basecolor.jpg" all normalize to "basecolor". */
function normalizeTextureKey(text: string): string {
  return text.replace(/[^a-z0-9]/g, "").toLowerCase();
}

/**
 * OBJ arrives as obj + mtl + texture URLs on different hosts. We fetch all
 * sidecars, rewrite the MTL's map_* references to local filenames, and ship
 * one zip so the download actually opens with textures intact. A map_* line
 * whose texture cannot be fetched is commented out — the MTL stays valid.
 */
async function packageObj(view: AssetJobView, baseName: string): Promise<DownloadedArtifact> {
  const objUrl = view.modelUrls.obj;
  const mtlUrl = view.modelUrls.mtl;
  if (!objUrl) throw new Error("provider produced no OBJ file");

  const textureByKey = new Map<string, string>();
  for (const group of view.textureUrls ?? []) {
    for (const [key, url] of Object.entries(group)) {
      if (url) textureByKey.set(normalizeTextureKey(key), url);
    }
  }

  const objText = new TextDecoder().decode(await fetchBytes(objUrl));
  const entries: { name: string; data: Uint8Array }[] = [
    { name: `${baseName}.obj`, data: new TextEncoder().encode(objText) },
  ];

  if (mtlUrl) {
    const mtlText = new TextDecoder().decode(await fetchBytes(mtlUrl));
    const lines = mtlText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*(map_[A-Za-z]{1,5})\s+(\S+)\s*$/.exec(lines[i]);
      if (!match) continue;
      const refBase = match[2].split(/[\\/]/).pop()!.replace(/\.[^.]*$/, "");
      const url = textureByKey.get(normalizeTextureKey(refBase));
      if (!url) {
        lines[i] = `# ${lines[i]} (texture unavailable)`;
        continue;
      }
      try {
        const bytes = await fetchBytes(url);
        const localName = `${normalizeTextureKey(refBase)}${/\.[^.]*$/.exec(url.split("?")[0])?.[0] ?? ".png"}`;
        lines[i] = `${match[1]} ${localName}`;
        entries.push({ name: localName, data: bytes });
      } catch {
        lines[i] = `# ${lines[i]} (texture unavailable)`;
      }
    }
    entries.push({ name: `${baseName}.mtl`, data: new TextEncoder().encode(lines.join("\n")) });
  }

  const zip = await buildStoreZip(entries).arrayBuffer();
  return { data: new Uint8Array(zip), contentType: "application/zip", filename: `${baseName}.zip` };
}

export async function fetchArtifact(view: AssetJobView, format: AssetFormat, baseName: string): Promise<DownloadedArtifact> {
  if (!MESHY_FORMATS.includes(format) || !view.modelUrls[format]) {
    throw new Error(`this asset has no ${format.toUpperCase()} output`);
  }
  if (format === "obj") return packageObj(view, baseName);

  const data = await fetchBytes(view.modelUrls[format]!);
  return { data, contentType: CONTENT_TYPES[format], filename: `${baseName}.${format}` };
}
