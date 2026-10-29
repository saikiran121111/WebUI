/**
 * Route tests for POST /api/internal/youtube-evidence (the Rust YouTube
 * vertical's InnerTube seam — app/api/internal/youtube-evidence/route.ts).
 * The heavy dependencies (youtubei.js session, browser caption engine)
 * are mocked at the module boundary: the route's contract is auth,
 * validation, the two transcript tiers with `captionSource`, the info
 * field-pick + video_id stamp, and comments passthrough.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getInfo: vi.fn(),
  getCaptionSegmentsViaBrowser: vi.fn(),
}));
vi.mock("@/lib/web-search/youtube", () => ({ getInfo: mocks.getInfo }));
vi.mock("@/lib/web-search/media-captions", () => ({
  getCaptionSegmentsViaBrowser: mocks.getCaptionSegmentsViaBrowser,
}));

import { POST } from "@/app/api/internal/youtube-evidence/route";

const SECRET = "test-bridge-secret";
const VID = "G0szOwYwqjI";

function req(body: unknown, secret?: string): NextRequest {
  return new NextRequest("http://localhost/api/internal/youtube-evidence", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-ruke-internal-secret": secret } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.RUKE_BROWSER_BRIDGE_SECRET = SECRET;
  mocks.getInfo.mockReset();
  mocks.getCaptionSegmentsViaBrowser.mockReset();
  mocks.getCaptionSegmentsViaBrowser.mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.RUKE_BROWSER_BRIDGE_SECRET;
});

describe("auth (same Tier-3b pattern as browser-read)", () => {
  it("401 when the secret env is unset — for every caller", async () => {
    delete process.env.RUKE_BROWSER_BRIDGE_SECRET;
    const res = await POST(req({ videoId: VID }, SECRET));
    expect(res.status).toBe(401);
  });
  it("401 on missing or wrong header (a length-matched wrong value too)", async () => {
    expect((await POST(req({ videoId: VID }))).status).toBe(401);
    expect((await POST(req({ videoId: VID }, "wrong-wrong-wrong-1"))).status).toBe(401);
    expect((await POST(req({ videoId: VID }, SECRET + "x"))).status).toBe(401);
  });
});

describe("validation", () => {
  it("400 on malformed JSON", async () => {
    const res = await POST(req("not-json{{{", SECRET));
    expect(res.status).toBe(400);
  });
  it("400 on non-11-char video ids", async () => {
    for (const bad of [undefined, "", "short", "has spaces!!!", "G0szOwYwqj!"]) {
      const res = await POST(req({ videoId: bad }, SECRET));
      expect(res.status, `videoId=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(mocks.getInfo).not.toHaveBeenCalled();
  });
});

describe("evidence assembly", () => {
  it("info null → all-null payload (Rust degrades to oEmbed), no browser probe", async () => {
    mocks.getInfo.mockResolvedValue(null);
    const res = await POST(req({ videoId: VID }, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      videoId: VID,
      info: null,
      transcript: null,
      comments: null,
      captionSource: null,
    });
    expect(mocks.getCaptionSegmentsViaBrowser).not.toHaveBeenCalled();
  });

  it("picks only whitelisted info fields and stamps video_id", async () => {
    mocks.getInfo.mockResolvedValue({
      basic_info: { title: "Khao Soi", channel: { id: "c", name: "mrnigelng" }, duration: 640 },
      someInternalSession: { cookie: "never-leaves" },
      getTranscript: async () => {
        throw new Error("POt 400");
      },
    });
    const res = await POST(req({ videoId: VID }, SECRET));
    const body = await res.json();
    expect(body.info.video_id).toBe(VID);
    expect(body.info.title).toBe("Khao Soi");
    expect(body.info.channel).toEqual({ id: "c", name: "mrnigelng" });
    expect(body.info.duration).toBe(640);
    expect("someInternalSession" in body.info).toBe(false);
    expect("getTranscript" in body.info).toBe(false);
  });

  it("tier 1: InnerTube getTranscript kept when it answers → captionSource innertube, no browser probe", async () => {
    mocks.getInfo.mockResolvedValue({
      basic_info: { title: "t" },
      getTranscript: async () => ({
        segments: [{ segment: { transcript_segment: { text: { content: "first" }, start_ms: 1500 } } }],
      }),
    });
    const body = await (await POST(req({ videoId: VID }, SECRET))).json();
    expect(body.captionSource).toBe("innertube");
    expect(body.transcript.segments).toHaveLength(1);
    expect(mocks.getCaptionSegmentsViaBrowser).not.toHaveBeenCalled();
  });

  it("tier 2: InnerTube throws (the POt norm) → browser caption engine, normalized to snake_case start_ms", async () => {
    mocks.getInfo.mockResolvedValue({
      basic_info: { title: "t" },
      getTranscript: async () => {
        throw new Error("400 FAILED_PRECONDITION");
      },
    });
    mocks.getCaptionSegmentsViaBrowser.mockResolvedValue([
      { text: "step one", startMs: 1500 },
      { text: "step two", startMs: 90_000 },
    ]);
    const body = await (await POST(req({ videoId: VID }, SECRET))).json();
    expect(body.captionSource).toBe("browser-cc");
    // The exact shape the Rust transcript_lines parser consumes.
    expect(body.transcript).toEqual({
      segments: [
        { text: "step one", start_ms: 1500 },
        { text: "step two", start_ms: 90_000 },
      ],
    });
    expect(mocks.getCaptionSegmentsViaBrowser).toHaveBeenCalledWith(
      `https://www.youtube.com/watch?v=${VID}`,
    );
  });

  it("both tiers empty → transcript null + captionSource null (comments still flow)", async () => {
    mocks.getInfo.mockResolvedValue({
      basic_info: { title: "t" },
      getTranscript: async () => ({}), // answers, but zero segments
      getComments: async () => [{ comment: { content: "yum", author: "a", like_count: 2 } }],
    });
    const body = await (await POST(req({ videoId: VID }, SECRET))).json();
    expect(body.transcript).toBeNull();
    expect(body.captionSource).toBeNull();
    expect(body.comments).toHaveLength(1);
  });

  it("comments: unwraps {comments:[…]}, drops empty and throwing arms to null", async () => {
    const post = async () =>
      (await (await POST(req({ videoId: VID }, SECRET))).json()).comments;

    const base = { basic_info: { title: "t" }, getTranscript: async () => ({}) };
    mocks.getInfo.mockResolvedValue({
      ...base,
      getComments: async () => ({ comments: [{ text: { content: "hi" } }] }),
    });
    expect(await post()).toHaveLength(1);

    mocks.getInfo.mockResolvedValue({ ...base, getComments: async () => [] });
    expect(await post()).toBeNull();

    mocks.getInfo.mockResolvedValue({
      ...base,
      getComments: async () => {
        throw new Error("comments gated");
      },
    });
    expect(await post()).toBeNull();
  });
});
