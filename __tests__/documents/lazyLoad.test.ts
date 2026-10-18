/**
 * PHASE 6 (lazy-load exclusivity): the browser E2E mocks /api/chat so the
 * Core Skill Intent Router never runs there — exclusivity is proven HERE,
 * against the REAL .cskills/ + .cskills-scenarios/ trees in this repo.
 * A PDF request must inject ONLY the pdf skill bundle: zero tokens from
 * xlsx/pptx/docx/powerbi/resume-builder, and vice-versa.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { applyCoreSkillRouting } from "@/lib/skills/coreRouter";

const ROOT = path.resolve(__dirname, "../..");

async function route(prompt: string): Promise<{ names: string[]; category: string | null }> {
  const payload = { model: "test", messages: [{ role: "user", content: prompt }] };
  const res = await applyCoreSkillRouting(payload, ROOT);
  const injected = payload.messages
    .filter((m: { role: string }) => m.role === "system")
    .map((m: { content: string }) => m.content)
    .find((c: string) => c.includes("<core_skill_routing"));
  const names = [...(injected ?? "").matchAll(/<core_skill name="([^"]+)"/g)].map((m) => m[1]);
  return { names, category: res.category };
}

const MODALITY_SKILLS = ["pdf", "resume-builder", "docx", "xlsx", "pptx", "powerbi", "html-viewer"];

describe("core skill lazy loading — zero cross-modality contamination", () => {
  it("PDF prompt loads ONLY the pdf skill", async () => {
    const { names } = await route("Generate a PDF report of our Q3 performance, printable and export to pdf");
    expect(names).toContain("pdf");
    expect(names.filter((n) => MODALITY_SKILLS.includes(n))).toEqual(["pdf"]);
  });

  it("Power BI prompt loads powerbi + its companions, never other modalities", async () => {
    const { names } = await route("Build a power bi dashboard from this CSV dataset with business intelligence measures");
    expect(names).toContain("powerbi");
    expect(names).toContain("d3-js-visualization");
    expect(names.filter((n) => ["pdf", "resume-builder", "docx", "xlsx", "pptx", "html-viewer"].includes(n))).toEqual([]);
  });

  it("resume prompt loads resume-builder + pdf only", async () => {
    const { names } = await route("Build me a resume for a senior frontend job application");
    expect(names).toContain("resume-builder");
    expect(names.filter((n) => ["docx", "xlsx", "pptx", "powerbi", "html-viewer"].includes(n))).toEqual([]);
  });

  it("presentation prompt loads ONLY pptx", async () => {
    const { names } = await route("Make a pitch deck slide deck presentation for investors");
    expect(names).toContain("pptx");
    expect(names.filter((n) => MODALITY_SKILLS.includes(n))).toEqual(["pptx"]);
  });

  it("excel prompt loads ONLY xlsx", async () => {
    const { names } = await route("Create an excel spreadsheet workbook with a financial model");
    expect(names).toContain("xlsx");
    expect(names.filter((n) => MODALITY_SKILLS.includes(n))).toEqual(["xlsx"]);
  });

  it("interactive HTML prompt loads html-viewer + design companions, no file modalities", async () => {
    const { names } = await route("Make an interactive bill splitter calculator as an animated html artifact");
    expect(names).toContain("html-viewer");
    expect(names.filter((n) => ["pdf", "resume-builder", "docx", "xlsx", "pptx", "powerbi"].includes(n))).toEqual([]);
  });

  it("routing category carries the exclusive modality", async () => {
    const { category } = await route("Export this as a word document docx file");
    expect(category).toBe("documents");
  });
});
