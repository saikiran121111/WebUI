import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  JOB_STAGES,
  ML_STATUS_ENDPOINT,
  backendStateLabel,
  capabilityLabel,
  interpretMlStatus,
  isTerminalStage,
  stageLabel,
  statusLabel,
} from "../../lib/progress/capabilityStatus";
import { MlStatusPoller } from "../../lib/progress/mlStatusPoller";
import { CapabilityStatusView } from "../../components/CapabilityStatusPanel";

/* ------------------------------------------------ the cross-language vocabulary */

const repoRoot = path.resolve(__dirname, "..", "..");
const contractsPy = readFileSync(path.join(repoRoot, "python-backend", "ruke_ml", "contracts.py"), "utf8");

function pythonTuple(name: string): string[] {
  const start = contractsPy.indexOf(`${name} = (`);
  if (start < 0) throw new Error(`${name} is no longer declared in contracts.py`);
  const end = contractsPy.indexOf(")", start);
  const body = contractsPy.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("capability vocabulary is one contract, not two", () => {
  it("TS job stages equal the backend PROGRESS_STATES, in order", () => {
    expect([...JOB_STAGES]).toEqual(pythonTuple("PROGRESS_STATES"));
  });

  it("TS capability ids equal the contract CAPABILITIES, in order", () => {
    expect([...CAPABILITY_IDS]).toEqual(pythonTuple("CAPABILITIES"));
  });

  it("the pool really reports the per-worker stage fields this UI reads", () => {
    // A field the backend stopped sending would silently render nothing here, so the
    // producer and the consumer are pinned together.
    const lifecycle = readFileSync(
      path.join(repoRoot, "python-backend", "ruke_ml", "models", "lifecycle.py"), "utf8");
    const report = lifecycle.slice(lifecycle.indexOf("def report("));
    for (const key of ["current_stage", "current_note", "last_state", "last_detail", "progress_seq"]) {
      expect(report).toContain(`"${key}"`);
    }
    expect(lifecycle).toContain('if kind == "progress":');
    expect(lifecycle).toMatch(/if kind == "progress":\n\s+#[\s\S]{0,400}?o\.current = state/);
  });
});

describe("stage labels", () => {
  it("labels a declared stage and refuses to invent one", () => {
    expect(stageLabel("transcribing")).toEqual({ label: "Transcribing audio", recognised: true });
    expect(stageLabel("download_required").label).toMatch(/download/i);
    const unknown = stageLabel("summarising_everything");
    expect(unknown).toEqual({ label: "summarising_everything", recognised: false });
  });

  it("knows its own terminal states and no others", () => {
    expect(isTerminalStage("ready")).toBe(true);
    expect(isTerminalStage("cancelled")).toBe(true);
    expect(isTerminalStage("extracting")).toBe(false);
    expect(isTerminalStage("")).toBe(false);
  });
});

describe("status labels", () => {
  it("names every declared state", () => {
    expect(statusLabel("available")).toBe("Available");
    expect(statusLabel("license_acceptance_required")).toBe("Licence acceptance required");
    expect(statusLabel("evaluation_required")).toBe("Needs a quality gate first");
    expect(statusLabel("not_supported_by_host")).toBe("Not supported on this machine");
  });

  it("reports an undeclared state as unavailable, never as a reassuring default", () => {
    expect(statusLabel("great")).toBe("State unavailable");
    expect(statusLabel("")).toBe("State unavailable");
  });

  it("labels the backend states", () => {
    expect(backendStateLabel("not_configured")).toMatch(/not started/i);
    expect(backendStateLabel("unreachable")).toMatch(/not answering/i);
  });
});

/* ------------------------------------------------------------- interpreting payloads */

const LIVE = {
  configured: true,
  live: true,
  source: "env",
  endpoint: "127.0.0.1:54321",
  supervisor_pid: 4242,
  supervisor: {
    state: "ready",
    uptime_s: 120.5,
    active_jobs: 1,
    heavy_worker_running: "embeddings",
    heavy_imports_at_startup: false,
    workers: {
      embeddings: {
        pid: 900, created: 133000000000000000, heavy: true, idle_s: 3.5,
        memory: { available: 1, working_set_mib: 812, private_mib: 900, peak_working_set_mib: 900 },
        resident: ["MiniLM"], current_stage: "transcribing", current_note: "2 texts",
        last_state: "ready", last_detail: "", progress_seq: 2,
      },
      rerank: {
        pid: 901, created: 1, heavy: false, idle_s: 9, resident: [],
        memory: { available: 0 }, current_stage: "", current_note: "",
        last_state: "failed", last_detail: "needs a query and chunks", progress_seq: 1,
      },
    },
  },
  capabilities: {
    embeddings: {
      status: "available", detail: "lexical baseline; states its own quality mode",
      human_step: "", models: [{ id: "ruke-lexical-hash", revision: "builtin", status: "available",
        builtin: true, heavy: false, claims: { coverage: "hashed lexical term weights, not model-quality" } }],
    },
    "speech.diarize": {
      status: "license_acceptance_required", detail: "terms not accepted",
      human_step: "accept the pyannote terms, then configure the token",
      models: [{ id: "pyannote/speaker-diarization-community-1", revision: "n/a",
        status: "license_acceptance_required", builtin: false, heavy: true }],
    },
    "video.timeline": {
      status: "not_installed", detail: "needs the external program ffmpeg",
      human_step: "install ffmpeg and put it on PATH", models: [],
    },
  },
  capability_details: {
    speech: { status: "evaluation_required", human_step: "install and evaluate an ASR checkpoint" },
  },
};

describe("interpretMlStatus", () => {
  it("reads a live answer including the owned workers", () => {
    const view = interpretMlStatus(LIVE);
    expect(view.state).toBe("live");
    expect(view.endpoint).toBe("127.0.0.1:54321");
    const sup = view.supervisor!;
    expect(sup.heavyImportsAtStartup).toBe(false);
    expect(sup.uptimeSeconds).toBe(120.5);
    expect(sup.workers.map((w) => w.capability)).toEqual(["embeddings", "rerank"]);
    expect(sup.workers[0].currentStage).toBe("transcribing");
    expect(sup.workers[0].memoryMiB).toBe(812);
    expect(sup.workers[0].resident).toEqual(["MiniLM"]);
    expect(sup.workers[1].lastDetail).toContain("query");
  });

  it("keeps an unmeasured memory value unknown instead of calling it zero", () => {
    const w = interpretMlStatus(LIVE).supervisor!.workers[1];
    expect(w.memoryMiB).toBeNull();
    expect(w.peakMemoryMiB).toBeNull();
  });

  it("carries the human step for a gated capability", () => {
    const diar = interpretMlStatus(LIVE).capabilities.find((c) => c.id === "speech.diarize")!;
    expect(diar.statusLabel).toBe("Licence acceptance required");
    expect(diar.humanStep).toMatch(/terms/);
    const vid = interpretMlStatus(LIVE).capabilities.find((c) => c.id === "video.timeline")!;
    expect(vid.statusLabel).toBe("Not installed");
  });

  it("marks a builtin adapter as this repo's own code with its own quality wording", () => {
    const emb = interpretMlStatus(LIVE).capabilities.find((c) => c.id === "embeddings")!;
    expect(emb.builtin).toBe(true);
    expect(emb.qualityNote).toMatch(/not model-quality/);
  });

  it("sorts capabilities by the declared contract order", () => {
    const ids = interpretMlStatus(LIVE).capabilities.map((c) => c.id);
    expect(ids).toEqual(["embeddings", "speech.diarize", "video.timeline"]);
  });

  it("reports a backend that was never started", () => {
    const view = interpretMlStatus({ configured: false, live: false, reason: "not_configured",
      detail: "RUKE_ML_URL is not set", human_step: "run npm run dev" });
    expect(view.state).toBe("not_configured");
    expect(view.humanStep).toMatch(/npm run dev/);
    expect(view.capabilities).toEqual([]);
  });

  it("reports a configured backend that stopped answering", () => {
    const view = interpretMlStatus({ configured: true, live: false, reason: "unreachable",
      detail: "/health: connection refused", endpoint: "127.0.0.1:1" });
    expect(view.state).toBe("unreachable");
    expect(backendStateLabel(view.state)).toMatch(/not answering/);
  });

  it("treats a body it cannot read as unknown rather than as an empty healthy backend", () => {
    for (const bad of [null, undefined, 7, "nope", []]) {
      const view = interpretMlStatus(bad);
      expect(view.state).toBe("unknown");
      expect(view.stateLabel).toMatch(/unknown/i);
    }
  });

  it("still reads an older server that sent the supervisor envelope verbatim", () => {
    // The real fix is split_capabilities() in ml_bridge.rs; this is the safety net, so an
    // un-upgraded server cannot produce a panel with an empty capability table.
    const nested = { configured: true, live: true,
      capabilities: { capabilities: { rerank: { status: "available", detail: "builtin", models: [] } },
        ocr: { status: "not_installed", human_step: "install an OCR engine" } } };
    const view = interpretMlStatus(nested);
    expect(view.capabilities.map((c) => c.id)).toEqual(["rerank"]);
    expect(view.familyNotes.some((n) => n.id === "ocr" && /install/.test(n.humanStep))).toBe(true);
  });

  it("ignores a stray scalar in the capability table", () => {
    const view = interpretMlStatus({ configured: true, live: true,
      capabilities: { rerank: "yes" } });
    expect(view.capabilities).toEqual([]);
  });
});

/* -------------------------------------------------------------------- the poller */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

type Gate = { promise: Promise<any>; resolve: (v: any) => void; reject: (e: unknown) => void };
type GateList = Gate[];

interface Harness {
  requests: Array<{ url: string; signal?: AbortSignal }>;
  gates: GateList;
  timers: Array<{ at: number; run: () => void }>;
  now: number;
  advance: (ms: number) => Promise<void>;
}

function makeHarness() {
  const h: Harness = {
    requests: [], gates: [], timers: [], now: 0,
    async advance(ms: number) {
      h.now += ms;
      const due = h.timers.filter((t) => t.at <= h.now);
      h.timers = h.timers.filter((t) => t.at > h.now);
      for (const t of due) { t.run(); await Promise.resolve(); await Promise.resolve(); }
    },
  };
  return h;
}

function poller(h: Harness, options: Partial<ConstructorParameters<typeof MlStatusPoller>[0]> = {}) {
  const views: any[] = [];
  const failures: string[] = [];
  const p = new MlStatusPoller({
    url: ML_STATUS_ENDPOINT,
    intervalMs: 1000,
    maxIntervalMs: 4000,
    fetchImpl: ((url: string, init: any) => {
      h.requests.push({ url, signal: init?.signal });
      const gate = deferred<any>();
      h.gates.push(gate);
      return gate.promise;
    }) as never,
    setTimer: ((fn: () => void, ms: number) => {
      const entry = { at: h.now + ms, run: fn };
      h.timers.push(entry);
      return entry as never;
    }) as never,
    clearTimer: ((handle: never) => {
      h.timers = h.timers.filter((t) => t !== (handle as unknown as Harness["timers"][number]));
    }) as never,
    onView: (v) => views.push(v),
    onTransportFailure: (info) => failures.push(`${info.message}|${info.nextDelayMs}`),
    ...options,
  });
  return { poller: p, views, failures };
}

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("MlStatusPoller", () => {
  it("hits the status endpoint once, then on schedule", async () => {
    const h = makeHarness();
    const { poller: p, views } = poller(h);
    p.start();
    await settle();
    expect(h.requests).toHaveLength(1);
    h.gates[0].resolve(jsonResponse(LIVE));
    await settle();
    expect(views).toHaveLength(1);
    await h.advance(1000);
    expect(h.requests).toHaveLength(2);
    p.stop();
  });

  it("never runs two requests at once, even on a manual refresh", async () => {
    const h = makeHarness();
    const { poller: p } = poller(h);
    p.start();
    await settle();
    p.refreshNow();
    p.refreshNow();
    await settle();
    expect(h.requests).toHaveLength(1);
    h.gates[0].resolve(jsonResponse(LIVE));
    await settle();
    expect(p.appliedSequence()).toBe(1);
    p.stop();
  });

  it("discards a reply from a request it already abandoned", async () => {
    const h = makeHarness();
    const { poller: p, views } = poller(h);
    p.start();
    await settle();
    p.stop();                 // the panel closed; the reply is still outstanding
    p.start();                // reopened: a fresh request now owns the endpoint
    await settle();
    expect(h.requests).toHaveLength(2);
    h.gates[0].resolve(jsonResponse({ configured: false, live: false, reason: "not_configured" }));
    await settle();
    expect(views).toHaveLength(0);            // the stale answer must not appear at all
    h.gates[1].resolve(jsonResponse(LIVE));
    await settle();
    expect(views).toHaveLength(1);
    expect(views[0].state).toBe("live");
    p.stop();
  });

  it("aborts the in-flight request when it stops", async () => {
    const h = makeHarness();
    const { poller: p } = poller(h);
    p.start();
    await settle();
    const signal = h.requests[0].signal!;
    expect(signal.aborted).toBe(false);
    p.stop();
    expect(signal.aborted).toBe(true);
    expect(p.isStopped()).toBe(true);
    h.gates[0].reject(new Error("abort"));
    await settle();
    p.refreshNow();                           // a refresh after stop must be inert
    await settle();
    expect(h.requests).toHaveLength(1);
  });

  it("backs off on failure up to the ceiling instead of hammering the endpoint", async () => {
    const h = makeHarness();
    const { poller: p, failures } = poller(h);
    p.start();
    await settle();
    h.gates[0].reject(new Error("ECONNREFUSED"));
    await settle();
    expect(failures[0]).toBe("ECONNREFUSED|1000");
    await h.advance(1000);
    h.gates[1].reject(new Error("ECONNREFUSED"));
    await settle();
    expect(failures[1]).toBe("ECONNREFUSED|2000");
    await h.advance(2000);
    h.gates[2].reject(new Error("ECONNREFUSED"));
    await settle();
    expect(failures[2]).toBe("ECONNREFUSED|4000");
    expect(h.timers.every((t) => t.at - h.now <= 4000)).toBe(true);
    p.stop();
  });

  it("keeps the last honest answer and reports a transport failure separately", async () => {
    const h = makeHarness();
    const { poller: p, views, failures } = poller(h);
    p.start();
    await settle();
    h.gates[0].resolve(jsonResponse(LIVE));
    await settle();
    await h.advance(1000);
    h.gates[1].reject(new Error("socket hang up"));
    await settle();
    expect(failures.length).toBe(1);
    expect(views.length).toBe(1);
    expect(views[0].state).toBe("live");
    p.stop();
  });

  it("treats an HTTP error as a failure, not as a capability answer", async () => {
    const h = makeHarness();
    const { poller: p, views, failures } = poller(h);
    p.start();
    await settle();
    h.gates[0].resolve({ ok: false, status: 500, json: async () => ({}) });
    await settle();
    expect(views).toHaveLength(0);
    expect(failures[0]).toMatch(/HTTP 500/);
    p.stop();
  });
});

/* ------------------------------------------------------------------- the rendering */

describe("CapabilityStatusView", () => {
  it("shows the license step a human must take, and never a made-up number", () => {
    const html = renderToStaticMarkup(
      h(CapabilityStatusView, { view: interpretMlStatus(LIVE), error: null, onRefresh: () => {} }),
    );
    expect(html).toContain("Licence acceptance required");
    expect(html).toContain("accept the pyannote terms");
    expect(html).toContain("Transcribing audio");
    expect(html).toContain("install ffmpeg and put it on PATH");
    // Judge the visible text: an invented percentage or a completion forecast would be
    // readable words, and checking attributes only would let one hide inside markup.
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(text).not.toMatch(/\bETA\b|estimated (time|finish|arrival)|time left|remaining (time|until)|minutes? (to go|left)/i);
    expect(text).not.toMatch(/NaN|undefined|null/);
  });

  it("prints an unrecognised stage raw and flags it", () => {
    const row = JSON.parse(JSON.stringify(LIVE));
    row.supervisor.workers.embeddings.current_stage = "vibes";
    const html = renderToStaticMarkup(
      h(CapabilityStatusView, { view: interpretMlStatus(row), error: null, onRefresh: () => {} }),
    );
    expect(html).toContain('data-recognised="false"');
    expect(html).toContain(">vibes<");
  });

  it("renders a finished job as history, not as something happening now", () => {
    const html = renderToStaticMarkup(
      h(CapabilityStatusView, { view: interpretMlStatus(LIVE), error: null, onRefresh: () => {} }),
    );
    expect(html).toContain("last job: Failed");
    expect(html).toContain("needs a query and chunks");
  });

  it("renders an idle supervisor honestly", () => {
    const row = JSON.parse(JSON.stringify(LIVE));
    row.supervisor.workers = {};
    row.supervisor.heavy_worker_running = null;
    const html = renderToStaticMarkup(
      h(CapabilityStatusView, { view: interpretMlStatus(row), error: null, onRefresh: () => {} }),
    );
    expect(html).toContain("No helper process is alive");
    expect(html).toContain("no heavy framework imported at startup");
  });

  it("says what a human must do when the backend was never started", () => {
    const html = renderToStaticMarkup(
      h(CapabilityStatusView, {
        view: interpretMlStatus({ configured: false, live: false, reason: "not_configured",
          detail: "no rendezvous file", human_step: "start it with npm run dev" }),
        error: null,
        onRefresh: () => {},
      }),
    );
    expect(html).toContain("Capability backend not started");
    expect(html).toContain("start it with npm run dev");
  });

  it("labels capability ids the contract has never heard of by their id", () => {
    expect(capabilityLabel("quantum.vibe")).toBe("quantum.vibe");
  });
});
