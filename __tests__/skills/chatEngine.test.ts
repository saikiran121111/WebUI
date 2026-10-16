/**
 * Integration test for the lazy skill engine inside POST /api/chat.
 * A mock llama.cpp server captures every upstream payload so we can assert
 * exactly what got injected (or not) and when the tool loop fires.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let mockServer: http.Server;
let upstreamPayloads: any[] = [];
let fixtureRoot: string;
let mockAnswersToolCall = true;

function sse(obj: unknown): string {
  return "data: " + JSON.stringify(obj) + "\n\n";
}

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      upstreamPayloads.push(payload);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (payload.tools && mockAnswersToolCall) {
        res.write(sse({ choices: [{ delta: { tool_calls: [{
          index: 0, id: "call_1",
          function: { name: "load_skill", arguments: JSON.stringify({ skill_name: "test-skill" }) },
        }] } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
      } else {
        res.write(sse({ choices: [{ delta: { content: "final answer" } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      }
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

beforeEach(async () => {
  upstreamPayloads = [];
  mockAnswersToolCall = true;
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

  process.env.WEBUI_SKILLS_ROOT = fixtureRoot;
  process.env.LLM_API_URL =
    "http://127.0.0.1:" + (mockServer.address() as any).port + "/v1/chat/completions";
});

async function importChatRoute() {
  // LLM_URL is read at module load: reset modules so the env above takes hold.
  vi.resetModules();
  return await import("../../app/api/chat/route");
}

async function postChat(text: string) {
  const { POST } = await importChatRoute();
  const request = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "user", content: text }] }),
  });
  const res = await (POST as any)(request);
  return { res, body: await res.text() };
}

function injectedSkillBodies(payload: any): string[] {
  return payload.messages
    .map((m: any) => (typeof m.content === "string" ? m.content : ""))
    .filter((c: string) => c.includes("<active_skill"));
}

describe("POST /api/chat — Mode 1: explicit /skill-name", () => {
  it("strips the slash prefix and injects the SKILL.md body for this turn", async () => {
    const { res, body } = await postChat("/test-skill explain recursion");
    expect(res.headers.get("X-Used-Skill")).toBe("test-skill");
    expect(body).toContain("final answer");

    const payload = upstreamPayloads[0];
    const last = payload.messages[payload.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("explain recursion");
    expect(injectedSkillBodies(payload)).toHaveLength(1);
    expect(injectedSkillBodies(payload)[0]).toContain("<active_skill name=\"test-skill\"");
    expect(injectedSkillBodies(payload)[0]).toContain("Always answer in exactly one sentence.");
  });

  it("does not intercept a disabled skill", async () => {
    const { res, body } = await postChat("/disabled-skill hello");
    expect(res.headers.get("X-Used-Skill")).toBeNull();
    expect(body).toContain("final answer");
    const payload = upstreamPayloads[0];
    expect(payload.messages[payload.messages.length - 1].content).toBe("/disabled-skill hello");
    expect(injectedSkillBodies(payload)).toHaveLength(0);
  });
});

describe("POST /api/chat — Mode 2: auto-use scenario routing", () => {
  it("pre-router keyword hit injects the body directly (no tool round-trip)", async () => {
    const { res, body } = await postChat("please summarize this report for me");
    expect(res.headers.get("X-Used-Skill")).toBe("test-skill");
    expect(body).toContain("final answer");
    expect(upstreamPayloads).toHaveLength(1);
    expect(injectedSkillBodies(upstreamPayloads[0])).toHaveLength(1);
    expect(upstreamPayloads[0].tools).toBeUndefined();
  });

  it("missed pre-router offers the load_skill tool and follows the tool call", async () => {
    const { res, body } = await postChat("what is the tallest mountain on earth");
    expect(res.headers.get("X-Used-Skill")).toBe("test-skill");
    expect(body).toContain("final answer");
    expect(upstreamPayloads).toHaveLength(2);

    const round1 = upstreamPayloads[0];
    expect(round1.tools?.[0]?.function?.name).toBe("load_skill");
    const routerMsg = round1.messages.map((m: any) => m.content ?? "").join("\n");
    expect(routerMsg).toContain("<skill_router>");
    expect(routerMsg).toContain("Use when the user asks to summarize text.");
    // The router block carries only name + whenToUse — never the SKILL.md body.
    expect(routerMsg).not.toContain("Always answer in exactly one sentence.");

    const round2 = upstreamPayloads[1];
    expect(injectedSkillBodies(round2)).toHaveLength(1);
    expect(round2.tools).toBeUndefined();
  });

  it("replays the model's plain answer when it skips the tool call", async () => {
    mockAnswersToolCall = false;
    const { res, body } = await postChat("what is the tallest mountain on earth");
    expect(res.headers.get("X-Used-Skill")).toBeNull();
    expect(body).toContain("final answer");
    expect(upstreamPayloads).toHaveLength(1);
    expect(injectedSkillBodies(upstreamPayloads[0])).toHaveLength(0);
  });

  it("unmatched turns pay only the tiny router block, never the SKILL.md body", async () => {
    mockAnswersToolCall = false; // model ignores the load_skill offer
    const { res, body } = await postChat("write a haiku about the sea");
    expect(res.headers.get("X-Used-Skill")).toBeNull();
    expect(body).toContain("final answer");
    expect(upstreamPayloads).toHaveLength(1);
    expect(injectedSkillBodies(upstreamPayloads[0])).toHaveLength(0);
    const round1Text = upstreamPayloads[0].messages.map((m: any) => m.content ?? "").join("\n");
    expect(round1Text).toContain("<skill_router>");
    expect(round1Text).not.toContain("Always answer in exactly one sentence.");
  });
});
