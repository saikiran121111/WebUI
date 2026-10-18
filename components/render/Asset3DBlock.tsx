"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Grid3x3, Maximize2, RotateCcw, Box, Sparkles } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { parseJsonFence } from "../../lib/render/schemas";
import { asset3dSpecSchema, type Asset3DSpec } from "../../lib/three3d/sceneSchema";
import Mascot from "../ui/Mascot";

/**
 * Renders ```asset3d fences: genuine provider-generated meshes (Mode B).
 * The browser talks only to our own /api/3d routes with an opaque job id —
 * the provider API key never reaches the client. With no provider on the
 * server the block says so honestly and points at procedural scene3d; it
 * never fakes a result. The finished GLB previews in the same professional
 * viewer; download buttons appear only for formats this job actually
 * produced (OBJ ships as a textured zip).
 */
interface Asset3DBlockProps {
  source: string;
  streaming?: boolean;
}

interface JobSnapshot {
  jobId: string;
  status: string;
  progress: number;
  modelUrls: Record<string, string>;
  thumbnailUrl?: string;
  error?: string;
}

const ALL_FORMATS = ["glb", "obj", "fbx", "stl", "usdz", "3mf"] as const;

export default memo(function Asset3DBlock({ source, streaming = false }: Asset3DBlockProps) {
  const parsed = useMemo(() => parseJsonFence(source, asset3dSpecSchema), [source]);

  if (!parsed.ok) {
    if (streaming) return null;
    return (
      <div className="asset3d-block" data-testid="asset3d-error">
        <div className="diagram-error-note">3D asset request did not validate — showing the source instead.</div>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }
  return <Asset3DView spec={parsed.value} />;
});

type Phase = "starting" | "working" | "succeeded" | "failed" | "unconfigured";

function Asset3DView({ spec }: { spec: Asset3DSpec }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [note, setNote] = useState("");
  const jobIdRef = useRef("");
  const startedRef = useRef(false);
  const timerRef = useRef(0);
  const aliveRef = useRef(true);

  const slug = useMemo(
    () => (spec.title ?? "asset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "asset",
    [spec.title],
  );

  // The job chain lives in refs, not per-run closures: StrictMode's first
  // cleanup must not strand the only in-flight request (the startedRef guard
  // means no second run would restart it). aliveRef tracks the live mount —
  // the second run flips it back to true after the first cleanup set it false.
  useEffect(() => {
    aliveRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      void start();
    }
    return () => { aliveRef.current = false; window.clearTimeout(timerRef.current); };

    async function poll() {
      try {
        const res = await fetch(`/api/3d/assets/${encodeURIComponent(jobIdRef.current)}`);
        if (!aliveRef.current) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setPhase("failed");
          setNote(data?.error ?? `status request failed (HTTP ${res.status})`);
          return;
        }
        if (data.nextJobId) jobIdRef.current = data.nextJobId; // preview → PBR refine hand-off
        setJob({
          jobId: jobIdRef.current,
          status: data.status ?? "processing",
          progress: typeof data.progress === "number" ? data.progress : 0,
          modelUrls: data.modelUrls ?? {},
          thumbnailUrl: data.thumbnailUrl ?? undefined,
          error: data.error ?? undefined,
        });
        if (data.status === "succeeded") { setPhase("succeeded"); return; }
        if (data.status === "failed" || data.status === "canceled") {
          setPhase("failed");
          setNote(data.error ?? `generation ${data.status}`);
          return;
        }
        timerRef.current = window.setTimeout(poll, 3000);
      } catch {
        if (aliveRef.current) { setPhase("failed"); setNote("Could not reach the 3D asset API."); }
      }
    }

    async function start() {
      try {
        const res = await fetch("/api/3d/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: spec.prompt, formats: spec.formats, quality: spec.quality }),
        });
        if (!aliveRef.current) return;
        const data = await res.json().catch(() => ({}));
        if (res.status === 503) {
          setPhase("unconfigured");
          setNote(data?.error ?? "No 3D generation provider is configured on this server.");
          return;
        }
        if (!res.ok || !data.jobId) {
          setPhase("failed");
          setNote(data?.error ?? `generation request failed (HTTP ${res.status})`);
          return;
        }
        jobIdRef.current = data.jobId;
        setPhase("working");
        setJob({ jobId: data.jobId, status: "pending", progress: 0, modelUrls: {} });
        poll();
      } catch {
        if (aliveRef.current) { setPhase("failed"); setNote("Could not reach the 3D asset API."); }
      }
    }
  }, [spec]);

  /* ── finished-asset preview (same viewer as procedural scenes) ───────── */
  const previewRef = useRef<HTMLDivElement>(null);
  const previewViewerRef = useRef<any>(null);
  const [previewError, setPreviewError] = useState("");
  const [pGrid, setPGrid] = useState(true);
  const [pWire, setPWire] = useState(false);

  useEffect(() => {
    if (phase !== "succeeded" || !job?.modelUrls.glb) return;
    const stage = previewRef.current;
    if (!stage) return;
    let disposed = false;

    void (async () => {
      const three = await import("three");
      const [{ ViewerCore }, { GLTFLoader }] = await Promise.all([
        import("../../lib/three3d/viewerCore"),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
      ]);
      if (disposed || !previewRef.current) return;
      let viewer: any;
      try {
        viewer = new ViewerCore(three, stage, { preset: "studio" });
      } catch {
        setPreviewError("WebGL is unavailable in this browser.");
        return;
      }
      previewViewerRef.current = viewer;
      // Same-origin through our download route: no CORS exposure, no key exposure.
      const url = `/api/3d/assets/${encodeURIComponent(job.jobId)}/download?format=glb&name=${encodeURIComponent(slug)}`;
      new GLTFLoader().load(url,
        (gltf: any) => {
          if (disposed) return;
          viewer.setContent(gltf.scene, gltf.animations ?? [], { loop: true });
        },
        undefined,
        () => { if (!disposed) setPreviewError("Preview could not load the generated GLB."); },
      );
    })();

    return () => {
      disposed = true;
      previewViewerRef.current?.dispose();
      previewViewerRef.current = null;
      stage.replaceChildren();
    };
  }, [phase, job, slug]);

  const downloadUrl = (format: string) =>
    `/api/3d/assets/${encodeURIComponent(job?.jobId ?? "")}/download?format=${format}&name=${encodeURIComponent(slug)}`;

  const availableFormats = ALL_FORMATS.filter(f => job?.modelUrls[f]);

  return (
    <div className="asset3d-block" data-testid="asset3d-block" data-asset-title={spec.title ?? ""}>
      <div className="code-block-header">
        <span className="code-block-lang">{spec.title ?? "AI-generated 3D asset"}</span>
      </div>

      {phase !== "succeeded" && (
        <div className="asset3d-status" data-testid="asset3d-status">
          {job?.thumbnailUrl && <img className="asset3d-thumb" src={job.thumbnailUrl} alt="Generation preview" />}
          {(phase === "starting" || phase === "working") && <Mascot size={26} state="working" />}
          <div className="asset3d-progress">
            {phase === "starting" && <span>Requesting generation…</span>}
            {phase === "working" && <span>Generating mesh — {job?.status ?? "queued"}…</span>}
            {phase === "failed" && (
              <span className="asset3d-error-inline"><AlertTriangle size={13} /> {note}</span>
            )}
            {phase === "unconfigured" && (
              <span><Sparkles size={13} /> {note} Procedural 3D stays fully available — ask for a “3D scene” instead.</span>
            )}
            {(phase === "working" || phase === "starting") && (
              <div className="asset3d-progress-track" data-testid="asset3d-progress">
                <div className="asset3d-progress-fill" style={{ width: `${Math.max(job?.progress ?? 0, 4)}%` }} />
              </div>
            )}
            {phase === "working" && <span className="asset3d-pct">{Math.round(job?.progress ?? 0)}%</span>}
          </div>
        </div>
      )}

      {phase === "succeeded" && (
        <>
          {job?.modelUrls.glb ? (
            <div ref={previewRef} className="asset3d-stage" data-testid="asset3d-stage"
              role="img" aria-label={`Preview of generated asset: ${spec.title ?? "untitled"}`}>
              {previewError && <div className="diagram-error-note">{previewError}</div>}
            </div>
          ) : (
            <div className="asset3d-error-note">This job produced no GLB, so no in-app preview is available — use the downloads below.</div>
          )}
          <div className="scene3d-toolbar">
            <button type="button" className={`scene3d-tool-btn${pGrid ? " is-active" : ""}`} onClick={() => { const on = !pGrid; setPGrid(on); previewViewerRef.current?.setGrid(on); }} aria-pressed={pGrid}>
              <Grid3x3 size={13} /> Grid
            </button>
            <button type="button" className={`scene3d-tool-btn${pWire ? " is-active" : ""}`} onClick={() => { const on = !pWire; setPWire(on); previewViewerRef.current?.setWireframe(on); }} aria-pressed={pWire}>
              <Box size={13} /> Wireframe
            </button>
            <button type="button" className="scene3d-tool-btn" onClick={() => previewViewerRef.current?.resetView()}>
              <RotateCcw size={13} /> Reset view
            </button>
            <button type="button" className="scene3d-tool-btn" onClick={() => previewViewerRef.current?.enterFullscreen()}>
              <Maximize2 size={13} /> Fullscreen
            </button>
            {job && Object.keys(job.modelUrls).length > 0 && (
              <span className="scene3d-stats">{availableFormats.map(f => f.toUpperCase()).join(" · ")}</span>
            )}
          </div>
          <div className="asset3d-downloads" data-testid="asset3d-downloads">
            {availableFormats.map(f => (
              <a key={f} className="scene3d-tool-btn" href={downloadUrl(f)} data-testid={`asset3d-download-${f}`}>
                <Download size={13} /> {f.toUpperCase()}{f === "obj" ? " (textured zip)" : ""}
              </a>
            ))}
            {availableFormats.length === 0 && <span className="asset3d-error-note">The provider reported success but produced no downloadable files.</span>}
            {job?.error && <span className="asset3d-error-note">{job.error}</span>}
          </div>
        </>
      )}
    </div>
  );
}
