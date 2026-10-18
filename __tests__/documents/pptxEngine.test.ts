import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { buildPptx } from "@/lib/documents/pptxEngine";

const spec = {
  filename: "Q4 Product Launch",
  title: "Q4 Product Launch",
  tier: "insane",
  theme: { bg: "#0A0A0A", accent: "#38E8FF", positive: "#22C55E" },
  slides: [
    { layout: "title", title: "Q4 Product Launch", subtitle: "Ship the future", bullets: [], stats: [] },
    { layout: "stats", title: "Momentum", subtitle: "", bullets: [], stats: [
      { label: "Revenue", value: "$4.2M" }, { label: "Growth", value: "38%", suffix: " YoY" }, { label: "NPS", value: "72" },
    ] },
    { layout: "spotlight", title: "Flagship Feature", subtitle: "", bullets: ["Realtime sync", "Offline first"], stats: [] },
    { layout: "chart", title: "Adoption", subtitle: "", bullets: [], stats: [], chart: { type: "line", categories: ["Jul", "Aug", "Sep"], series: [{ name: "DAU", data: [120, 340, 890] }] } },
    { layout: "bullets", title: "Roadmap", subtitle: "", bullets: ["Mobile", "API", "Enterprise"], stats: [] },
  ],
};

describe("pptx engine (INSANE tier + OOXML Morph)", () => {
  it("injects <p159:morph option=\"byObject\"/> and !!-paired shape names into the slide XML", async () => {
    const out = await buildPptx(spec);
    expect(out.filename).toBe("Q4_Product_Launch.pptx");
    expect(out.tier).toBe("insane");

    const zip = unzipSync(new Uint8Array(out.buffer));
    const slideNames = Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => {
      return Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]);
    });
    expect(slideNames.length).toBe(5);

    const xmls = slideNames.map((n) => new TextDecoder().decode(zip[n]));

    // Morph transition on every incoming slide (2..5), inside mc:AlternateContent
    for (let i = 1; i < xmls.length; i++) {
      expect(xmls[i]).toContain("<p159:morph option=\"byObject\"");
      expect(xmls[i]).toContain("<mc:AlternateContent");
      expect(xmls[i]).toContain("<mc:Fallback>");
    }
    expect(xmls[0]).not.toContain("p159:morph");

    // `!!`-prefixed paired shape names (split-mask, stat fill, spotlight overlay)
    expect(xmls.join("")).toContain('name="!!SplitMask_s2"');
    expect(xmls.join("")).toContain('name="!!StatFill_s1"');
    expect(xmls.join("")).toContain('name="!!SpotlightOverlay_s2"');

    // moving spotlight: custGeom cutout (outer + reversed inner subpath) on the overlay
    const spotlightSlide = xmls[2];
    expect(spotlightSlide).toContain("<a:custGeom");
    // ElementTree serializes empty elements as `<a:close />` (with a space)
    expect((spotlightSlide.match(/<a:close\s*\/>/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // stat crop-fill srcRect pair: 100% entry crop (slide 1) → 0 target (slide 2)
    expect(xmls[0]).toContain('<a:srcRect t="100000"');
    expect(xmls[1]).toContain("<a:srcRect");

    // split-mask entry rotation 270° lives on the previous slide
    expect(xmls[0]).toContain('rot="16200000"');

    // chart slide embeds a PNG
    const media = Object.keys(zip).filter((n) => n.startsWith("ppt/media/"));
    expect(media.length).toBeGreaterThanOrEqual(2);
  }, 90000);

  it("simple tier emits no morph and no !! names", async () => {
    const out = await buildPptx({ ...spec, tier: "simple" });
    const zip = unzipSync(new Uint8Array(out.buffer));
    const all = Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map((n) => new TextDecoder().decode(zip[n])).join("");
    expect(all).not.toContain("p159:morph");
    expect(all).not.toContain('name="!!');
  }, 60000);
});
