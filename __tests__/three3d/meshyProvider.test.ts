import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isMeshyConfigured, createPreviewJob, pollJob, cancelJob, fetchArtifact, MESHY_FORMATS,
} from "../../lib/three3d/providers/meshy";
import type { AssetJobView } from "../../lib/three3d/providers/types";

const KEY = "test-meshy-key";
let originalKey: string | undefined;

beforeEach(() => { originalKey = process.env.MESHY_API_KEY; process.env.MESHY_API_KEY = KEY; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.MESHY_API_KEY;
  else process.env.MESHY_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}
function bytesResponse(bytes: Uint8Array) {
  return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer };
}

describe("isMeshyConfigured", () => {
  it("reflects the server environment only", () => {
    expect(isMeshyConfigured()).toBe(true);
    delete process.env.MESHY_API_KEY;
    expect(isMeshyConfigured()).toBe(false);
  });
});

describe("createPreviewJob", () => {
  it("posts the preview body and returns an opaque stage-tagged job id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ result: "task1234" }));
    vi.stubGlobal("fetch", fetchMock);
    const jobId = await createPreviewJob({ prompt: "a sneaker", formats: ["glb"], quality: "detailed" } as any);
    expect(jobId).toBe("meshy:pv:task1234");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/openapi/v2/text-to-3d");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe("preview");
    expect(body.target_polycount).toBe(100000);
  });

  it("surfaces a clear auth error on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 401)));
    await expect(createPreviewJob({ prompt: "x" } as any)).rejects.toThrow(/rejected the API key/);
  });
});

describe("pollJob", () => {
  it("rejects unknown job id formats", async () => {
    await expect(pollJob("not-a-job")).rejects.toThrow(/unknown asset job id/);
    await expect(pollJob("meshy:zz:task1234")).rejects.toThrow(/unknown asset job id/);
  });

  it("maps Meshy status/progress/urls into the provider-neutral view", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      status: "IN_PROGRESS", progress: 42, model_urls: {}, thumbnail_url: "https://t/thumb.png",
    })));
    const view = await pollJob("meshy:pv:task1234", { autoRefine: false });
    expect(view).toMatchObject({ provider: "meshy", status: "processing", progress: 42, thumbnailUrl: "https://t/thumb.png" });
  });

  it("autoRefine:false never starts the refine stage (download path safety)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://x/a.glb" } }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await pollJob("meshy:pv:task1234", { autoRefine: false });
    expect(view.status).toBe("succeeded");
    expect(view.nextJobId).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preview success hands off to the PBR refine stage by default", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ result: "ref5678" });
      return jsonResponse({ status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://x/a.glb" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await pollJob("meshy:pv:task1234");
    expect(view.nextJobId).toBe("meshy:rf:ref5678");
    const refineCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect((refineCall![0] as string)).toContain("/refine-text-to-3d/task1234");
    expect(JSON.parse((refineCall![1] as RequestInit).body as string).enable_pbr).toBe(true);
  });

  it("refine failure still delivers the preview honestly with a note", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? jsonResponse({}, 402) : jsonResponse({ status: "SUCCEEDED", model_urls: { glb: "https://x/a.glb" } }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await pollJob("meshy:pv:task1234");
    expect(view.status).toBe("succeeded");
    expect(view.error).toMatch(/Refine stage unavailable/);
  });
});

describe("cancelJob", () => {
  it("issues DELETE against the right stage endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await cancelJob("meshy:rf:task9999");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/openapi/v2/refine-text-to-3d/task9999");
    expect(init.method).toBe("DELETE");
  });
});

describe("fetchArtifact", () => {
  it("refuses formats this job never produced (no fake buttons)", async () => {
    const view: AssetJobView = { jobId: "meshy:pv:t1234", provider: "meshy", status: "succeeded", progress: 100, modelUrls: { glb: "https://x/a.glb" } };
    await expect(fetchArtifact(view, "fbx", "a")).rejects.toThrow(/no FBX output/);
    expect(MESHY_FORMATS).toContain("glb");
  });

  it("downloads a plain GLB with the right content type and filename", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytesResponse(new Uint8Array([0x67, 0x6c, 0x54, 0x46]))));
    const view: AssetJobView = { jobId: "meshy:pv:t1234", provider: "meshy", status: "succeeded", progress: 100, modelUrls: { glb: "https://x/a.glb" } };
    const artifact = await fetchArtifact(view, "glb", "rocket");
    expect(artifact.filename).toBe("rocket.glb");
    expect(artifact.contentType).toBe("model/gltf-binary");
    expect(artifact.data[0]).toBe(0x67);
  });

  it("packages OBJ as a zip with rewritten MTL and fetched textures; missing textures are commented out", async () => {
    const objBytes = new TextEncoder().encode("v 0 0 0\nf 1\n");
    const mtlBytes = new TextEncoder().encode("newmtl m\nmap_Kd base_color.png\nmap_Bump nope.png\n");
    const texBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith(".obj")) return bytesResponse(objBytes);
      if (url.endsWith(".mtl")) return bytesResponse(mtlBytes);
      if (url.includes("base_color")) return bytesResponse(texBytes);
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }));
    const view: AssetJobView = {
      jobId: "meshy:pv:t1234", provider: "meshy", status: "succeeded", progress: 100,
      modelUrls: { obj: "https://c/a.obj", mtl: "https://c/a.mtl" },
      textureUrls: [{ base_color: "https://c/tex/base_color.png?sig=1" }],
    };
    const artifact = await fetchArtifact(view, "obj", "rocket");
    expect(artifact.filename).toBe("rocket.zip");
    expect(artifact.contentType).toBe("application/zip");

    const text = new TextDecoder("latin1").decode(artifact.data);
    expect(text).toContain("rocket.obj");
    expect(text).toContain("rocket.mtl");
    expect(text).toContain("basecolor.png");            // texture entry shipped
    expect(text).toContain("map_Kd basecolor.png");     // MTL rewritten to local name
    expect(text).toContain("# map_Bump nope.png (texture unavailable)"); // invalid line commented, MTL stays valid
  });
});
