/**
 * Unit tests for the caption response listener in lib/web-search/
 * captionProbe.ts, using a minimal Page/Response stub. The contract
 * under test is TYPE-BLIND but TYPE-CORRECT capture: xhr/fetch AND
 * texttrack (Chromium's type for <track>-element loads — proven live
 * 2026-10-28: HTML5-native providers deliver ct=text/vtt as
 * rt=texttrack, which an xhr/fetch-only filter drops) are captured;
 * documents/media are not; only caption-shaped URLs qualify. No
 * provider names anywhere.
 */
import { describe, it, expect } from "vitest";
import { attachCaptionListener, type CaptionCaptureStore } from "@/lib/web-search/captionProbe";

type FakeRes = {
  url: () => string;
  request: () => { resourceType: () => string };
  text: () => Promise<string>;
};

function fakePage() {
  let handler: ((res: FakeRes) => void) | null = null;
  const page = {
    on: (_ev: string, cb: (res: FakeRes) => void) => {
      handler = cb;
    },
  };
  const fire = async (url: string, resourceType: string, body: string | Error) => {
    handler!({
      url: () => url,
      request: () => ({ resourceType: () => resourceType }),
      text: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
    });
    // Flush the res.text().then microtask chain the listener uses.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { page, fire };
}

const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello";
const JSON3 = '{"events":[{"tStartMs":1,"segs":[{"utf8":"a"}]}]}';

describe("attachCaptionListener capture contract", () => {
  it("captures xhr, fetch AND texttrack bodies on caption-shaped URLs", async () => {
    const store: CaptionCaptureStore = { bodies: [] };
    const { page, fire } = fakePage();
    attachCaptionListener(page as any, store); // minimal stub: only .on is touched
    await fire("https://p.example/captions?lang=en", "texttrack", VTT);
    await fire("https://p.example/timedtext?fmt=json3", "xhr", JSON3);
    await fire("https://p.example/subtitles/en", "fetch", VTT);
    expect(store.bodies).toHaveLength(3);
  });

  it("never captures documents or media (even when the URL mentions captions)", async () => {
    const store: CaptionCaptureStore = { bodies: [] };
    const { page, fire } = fakePage();
    attachCaptionListener(page as any, store); // minimal stub: only .on is touched
    await fire("https://p.example/captions/page.html", "document", "<html>caption page chrome</html>");
    await fire("https://p.example/api/captions/manifest.m3u8", "media", "#EXTM3U");
    await fire("https://p.example/captions.js", "script", "var x=1");
    expect(store.bodies).toHaveLength(0);
  });

  it("skips non-caption URLs regardless of type", async () => {
    const store: CaptionCaptureStore = { bodies: [] };
    const { page, fire } = fakePage();
    attachCaptionListener(page as any, store); // minimal stub: only .on is touched
    await fire("https://p.example/feeds/hls/master.m3u8", "xhr", "#EXTM3U");
    expect(store.bodies).toHaveLength(0);
  });

  it("survives an unavailable body (navigated away) and oversized payloads", async () => {
    const store: CaptionCaptureStore = { bodies: [] };
    const { page, fire } = fakePage();
    attachCaptionListener(page as any, store); // minimal stub: only .on is touched
    await fire("https://p.example/captions", "xhr", new Error("body unavailable"));
    await fire("https://p.example/captions", "xhr", "x".repeat(500_001));
    expect(store.bodies).toHaveLength(0);
  });
});
