/**
 * Integration test for the Decision Engine pipeline inside POST /api/chat.
 * A mock server plays BOTH roles — llama.cpp upstream (captures every payload
 * so we can assert exactly what was injected) and the decision worker
 * (/health + /decision). Keyword routers and the load_skill tool loop are
 * gone: slash skills, envelope injection, stripped_prompt and the
 * x-decision-mode header are what this pins down.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RENDERER_MODES, type RendererMode } from "@/lib/decision/types";

let mockServer: http.Server;
let upstreamPayloads: any[] = [];
let decisionHits = 0;
let fixtureRoot: string;
let mockDecision: { active_mode: RendererMode; skill: string | null; fence: string | null; stripped: string | null } = {
  active_mode: "standard_chat", skill: null, fence: null, stripped: null,
};

function sse(obj: unknown): string {
  return "data: " + JSON.stringify(obj) + "\n\n";
}

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, lfm: true }));
        return;
      }
      if (req.url === "/decision") {
        decisionHits++;
        const body = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          active_mode: mockDecision.active_mode,
          confidence: 0.97,
          decided_by: "mock",
          stripped_prompt: mockDecision.stripped ?? body.message,
          skill_to_load: mockDecision.skill,
          allowed_code_fence: mockDecision.fence,
          disable_validators: RENDERER_MODES.filter((m) => m !== mockDecision.active_mode),
          enable_validator: mockDecision.active_mode,
          task_constraints: [],
          extracted_entities: [],
          lfm_latency_ms: 1,
        }));
        return;
      }
      const payload = JSON.parse(raw);
      upstreamPayloads.push(payload);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "final answer" } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  upstreamPayloads = [];
  decisionHits = 0;
  mockDecision = { active_mode: "standard_chat", skill: null, fence: null, stripped: null };
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = mkdtempSync(join(tmpdir(), "webui-chat-engine-"));

  mkdirSync(join(fixtureRoot, "skills", "test-skill"), { recursive: true });
  writeFileSync(join(fixtureRoot, "skills", "test-skill", "SKILL.md"),
    "# Test Skill\nAlways answer in exactly one sentence.");
  mkdirSync(join(fixtureRoot, "skill-scenarios"), { recursive: true });
  writeFileSync(join(fixtureRoot, "skill-scenarios", "test-skill.json"), JSON.stringify({
    skillName: "test-skill",
    sourceRepo: "acme/test",
    enabled: true,
    autoUse: true,
    whenToUse: "Use when the user asks to summarize text.",
    triggerKeywords: ["summarize"],
    blockedReason: null,
  }));
  mkdirSync(join(fixtureRoot, "skills", "disabled-skill"), { recursive: true });
  writeFileSync(join(fixtureRoot, "skills", "disabled-skill", "SKILL.md"), "# Disabled");
  writeFileSync(join(fixtureRoot, "skill-scenarios", "disabled-skill.json"), JSON.stringify({
    skillName: "disabled-skill",
    sourceRepo: "acme/off",
    enabled: false,
    autoUse: false,
    whenToUse: "",
    triggerKeywords: [],
    blockedReason: null,
  }));

  // Core tier fixture: the engine's excel mode must load ONLY this bundle.
  mkdirSync(join(fixtureRoot, ".cskills", "xlsx"), { recursive: true });
  writeFileSync(join(fixtureRoot, ".cskills", "xlsx", "SKILL.md"),
    "# XLSX Core Skill\nEmit one xlsx fence with live formulas.");

  const base = "http://127.0.0.1:" + (mockServer.address() as any).port;
  process.env.WEBUI_SKILLS_ROOT = fixtureRoot;
  process.env.LLM_API_URL = base + "/v1/chat/completions";
  process.env.DECISION_ENGINE_URL = base;
  process.env.DECISION_ENGINE_AUTOSPAWN = "0";
  // Keep the Decision-Engine pipeline test deterministic: the chat route's
  // LFM web-search gate would otherwise call a real LLM classifier and run
  // live search-engine scrapers. The rules-only fallback keeps the test fast
  // and network-free while still exercising the routing + skill injection.
  process.env.WEB_SEARCH_LFM_DISABLED = "1";
});

async function importChatRoute() {
  // LLM_URL is read at module load: reset modules so the env above takes hold.
  vi.resetModules();
  return await import("../../app/api/chat/route");
}

async function postChat(text: string, extra: Record<string, unknown> = {}) {
  const { POST } = await importChatRoute();
  const request = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "user", content: text }], ...extra }),
  });
  const res = await (POST as any)(request);
  return { res, body: await res.text() };
}

function systemBlocks(payload: any, marker: string): string[] {
  return payload.messages
    .filter((m: any) => m.role === "system")
    .map((m: any) => (typeof m.content === "string" ? m.content : ""))
    .filter((c: string) => c.includes(marker));
}

describe("POST /api/chat — Decision Engine pipeline", () => {
  it("runs the engine first, injects ONE skill block + stripped_prompt, streams x-decision-mode", async () => {
    mockDecision = { active_mode: "excel", skill: "xlsx", fence: "xlsx", stripped: "500-row transaction tracker with SUMIFS alerts" };
    const { res, body } = await postChat("hey please can you build me a 500-row transaction tracker with SUMIFS alerts thanks");
    expect(decisionHits).toBe(1);
    expect(res.headers.get("x-decision-mode")).toBe("excel");
    expect(res.headers.get("X-Used-Skill")).toBeNull(); // core tier never surfaces
    expect(body).toContain("final answer");

    const payload = upstreamPayloads[0];
    const last = payload.messages[payload.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("500-row transaction tracker with SUMIFS alerts");

    const decision = systemBlocks(payload, "<decision_skill");
    expect(decision).toHaveLength(1);
    expect(decision[0]).toContain('<core_skill name="xlsx"');
    expect(decision[0]).toContain("Emit one xlsx fence with live formulas.");
    expect(decision[0]).toContain("<output_contract_xlsx>");
    // No standing visual-router prompt, no skill_router block, no tools.
    expect(payload.messages.some((m: any) => typeof m.content === "string" && m.content.includes("skill_router"))).toBe(false);
    expect(payload.tools).toBeUndefined();
  });

  it("standard_chat injects nothing and keeps the turn verbatim", async () => {
    const { res } = await postChat("why is my useEffect firing twice");
    expect(res.headers.get("x-decision-mode")).toBe("standard_chat");
    const payload = upstreamPayloads[0];
    expect(systemBlocks(payload, "<decision_skill")).toHaveLength(0);
    expect(systemBlocks(payload, "<active_skill")).toHaveLength(0);
    expect(payload.messages[payload.messages.length - 1].content).toBe("why is my useEffect firing twice");
  });

  it("engine down -> standard_chat fallback, every renderer stays off", async () => {
    process.env.DECISION_ENGINE_URL = "http://127.0.0.1:9/"; // nothing listens
    const { res, body } = await postChat("hello there");
    process.env.DECISION_ENGINE_URL = "http://127.0.0.1:" + (mockServer.address() as any).port;
    expect(res.headers.get("x-decision-mode")).toBe("standard_chat");
    expect(body).toContain("final answer");
    const payload = upstreamPayloads[0];
    expect(systemBlocks(payload, "<decision_skill")).toHaveLength(0);
    expect(payload.messages[payload.messages.length - 1].content).toBe("hello there");
  });

  it("decision_mode passthrough (fence repair) skips the engine entirely", async () => {
    const { res } = await postChat("Your previous ```xlsx fence failed validation: #REF!", { decision_mode: "excel" });
    expect(decisionHits).toBe(0);
    expect(res.headers.get("x-decision-mode")).toBe("excel");
    const payload = upstreamPayloads[0];
    expect(payload.decision_mode).toBeUndefined(); // never leaks upstream
    // Repair text reaches the model UNstripped, mode skill still loaded.
    expect(payload.messages[payload.messages.length - 1].content)
      .toBe("Your previous ```xlsx fence failed validation: #REF!");
    expect(systemBlocks(payload, "<decision_skill")).toHaveLength(1);
  });
});

describe("POST /api/chat — user-tier slash skills (only surviving user trigger)", () => {
  it("strips the slash prefix and injects the SKILL.md body for this turn", async () => {
    const { res, body } = await postChat("/test-skill explain recursion");
    expect(res.headers.get("X-Used-Skill")).toBe("test-skill");
    expect(body).toContain("final answer");

    const payload = upstreamPayloads[0];
    const last = payload.messages[payload.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("explain recursion");
    expect(systemBlocks(payload, "<active_skill")).toHaveLength(1);
    expect(systemBlocks(payload, "<active_skill")[0]).toContain("<active_skill name=\"test-skill\"");
    expect(systemBlocks(payload, "<active_skill")[0]).toContain("Always answer in exactly one sentence.");
    // Slash skill wins: the decision engine never stacks a second skill block.
    expect(systemBlocks(payload, "<decision_skill")).toHaveLength(0);
  });

  it("does not intercept a disabled skill", async () => {
    const { res } = await postChat("/disabled-skill hello");
    expect(res.headers.get("X-Used-Skill")).toBeNull();
    const payload = upstreamPayloads[0];
    expect(payload.messages[payload.messages.length - 1].content).toBe("/disabled-skill hello");
    expect(systemBlocks(payload, "<active_skill")).toHaveLength(0);
  });

  it("no keyword routing: an autoUse scenario no longer fires without the slash", async () => {
    const { res } = await postChat("please summarize this report for me");
    expect(res.headers.get("X-Used-Skill")).toBeNull();
    const payload = upstreamPayloads[0];
    expect(systemBlocks(payload, "<active_skill")).toHaveLength(0);
    expect(payload.tools).toBeUndefined();
  });
});
