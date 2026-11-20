/**
 * One authoritative provider configuration (amendment 8 section B).
 *
 * The defect: chat resolved settings.json > env > fallback while the Python lifecycle
 * resolver read env/.env.local first. One deployment could therefore chat to the server in
 * settings.json and unload the server named in .env.local. These tests pin the shared chain
 * (settings.json > process.env > .env.local > fallback) and prove the unload/reload URLs are
 * ANCHORED TO THE CHAT URL'S ORIGIN unless they are configured explicitly.
 *
 * Resolution is exercised against a throwaway cwd so this never reads or writes the real
 * repo settings.json / .env.local, and never needs a live model endpoint.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = [
  "LLM_API_URL",
  "LLM_API_KEY",
  "LLM_UNLOAD_URL",
  "LLM_RELOAD_URL",
  "RUKE_LLM_ENDPOINT",
  "RUKE_LLM_PROVIDER",
  "RUKE_LLM_MODEL",
  "RUKE_LIFECYCLE_BASE",
  "RUKE_LLM_AUTOMATIC_HANDOFF",
  "RUKE_OCR_ALLOW_UNLOAD",
] as const;

type SettingsModule = typeof import("../../lib/server/settings");

async function loadSettingsAt(cwd: string): Promise<SettingsModule> {
  const previous = process.cwd();
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.chdir(cwd);
  try {
    // Fresh module instances: the file caches are mtime-gated per module.
    vi.resetModules();
    return await import("../../lib/server/settings");
  } finally {
    process.chdir(previous);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function sandbox(write?: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruke-provider-"));
  write?.(dir);
  return dir;
}

const CHAT = "http://127.0.0.1:9099/v1/chat/completions";

describe("one provider chain (settings.json > process.env > .env.local > fallback)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length) {
      try {
        fs.rmSync(cleanups.pop()!, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("settings.json wins over both env layers, and lifecycle follows THAT origin", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ llm_api_url: CHAT, llm_api_key: "from-settings" }));
      fs.writeFileSync(path.join(d, ".env.local"), "LLM_API_URL=http://dotenv-host:1/v1/chat/completions\n");
    });
    cleanups.push(dir);
    process.env.LLM_API_URL = "http://env-host:1/v1/chat/completions";
    try {
      const m = await loadSettingsAt(dir);
      expect(m.llmApiUrl()).toBe(CHAT);
      expect(m.llmApiKey()).toBe("from-settings");
      const cfg = m.providerConfig();
      expect(cfg.controlOrigin).toBe("http://127.0.0.1:9099");
      expect(cfg.unloadUrl).toBe("http://127.0.0.1:9099/unload");
      expect(cfg.reloadUrl).toBe("http://127.0.0.1:9099/load");
      expect(cfg.configSource.chatUrl).toBe("settings.json(LLM_API_URL)");
      expect(cfg.configSource.controlOrigin).toContain("derived-from-chatUrl");
    } finally {
      delete process.env.LLM_API_URL;
    }
  });

  it("process.env beats .env.local, and .env.local is a real layer at all", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, ".env.local"), 'LLM_API_URL="http://127.0.0.1:8080/v1/chat/completions"\nLLM_API_KEY=dotenv-key\n');
    });
    cleanups.push(dir);
    const a = await loadSettingsAt(dir);
    expect(a.llmApiUrl()).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(a.llmApiKey()).toBe("dotenv-key");
    expect(a.providerConfig().configSource.chatUrl).toBe(".env.local(LLM_API_URL)");

    process.env.LLM_API_URL = CHAT;
    try {
      const b = await loadSettingsAt(dir);
      expect(b.llmApiUrl()).toBe(CHAT);
      expect(b.providerConfig().configSource.chatUrl).toBe("process.env(LLM_API_URL)");
    } finally {
      delete process.env.LLM_API_URL;
    }
  });

  it("an explicit URL prefix survives, and lifecycle stays on the same host", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ llm_api_url: "https://gw.example.com/tenant/v1/chat/completions" }));
    });
    cleanups.push(dir);
    const m = await loadSettingsAt(dir);
    const cfg = m.providerConfig();
    expect(cfg.chatUrl).toBe("https://gw.example.com/tenant/v1/chat/completions");
    expect(cfg.controlOrigin).toBe("https://gw.example.com");
    expect(cfg.unloadUrl).toBe("https://gw.example.com/unload");
  });

  it("an operator-pinned control origin is reported, never invented", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ llm_api_url: CHAT }));
    });
    cleanups.push(dir);
    process.env.RUKE_LLM_ENDPOINT = "http://127.0.0.1:8080/";
    try {
      const m = await loadSettingsAt(dir);
      const cfg = m.providerConfig();
      expect(cfg.chatUrl).toBe(CHAT);
      expect(cfg.controlOrigin).toBe("http://127.0.0.1:8080");
      expect(cfg.configSource.controlOrigin).toBe("process.env(RUKE_LLM_ENDPOINT)");
      expect(cfg.lifecycleExplicit).toBe(false);
    } finally {
      delete process.env.RUKE_LLM_ENDPOINT;
    }
  });

  it("configured lifecycle URLs win and are marked explicit", async () => {
    const dir = sandbox();
    cleanups.push(dir);
    process.env.LLM_API_URL = CHAT;
    process.env.LLM_UNLOAD_URL = "http://127.0.0.1:8080/v1/unload";
    process.env.LLM_RELOAD_URL = "http://127.0.0.1:8080/v1/load";
    try {
      const m = await loadSettingsAt(dir);
      const urls = m.llmLifecycleUrls();
      expect(urls.unloadUrl).toBe("http://127.0.0.1:8080/v1/unload");
      expect(urls.reloadUrl).toBe("http://127.0.0.1:8080/v1/load");
      expect(m.providerConfig().lifecycleExplicit).toBe(true);
    } finally {
      delete process.env.LLM_API_URL;
      delete process.env.LLM_UNLOAD_URL;
      delete process.env.LLM_RELOAD_URL;
    }
  });

  // Amendment 11 section 21.1: one base for BOTH lifecycle paths, prefix preserved.
  it("RUKE_LIFECYCLE_BASE keeps its path prefix and anchors both lifecycle paths", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ llm_api_url: "https://gw.example.com/tenant/v1/chat/completions" }));
    });
    cleanups.push(dir);
    process.env.RUKE_LIFECYCLE_BASE = "https://gw.example.com/tenant/v1/";
    try {
      const m = await loadSettingsAt(dir);
      const cfg = m.providerConfig();
      expect(cfg.lifecycleBase).toBe("https://gw.example.com/tenant/v1");
      expect(cfg.unloadUrl).toBe("https://gw.example.com/tenant/v1/unload");
      expect(cfg.reloadUrl).toBe("https://gw.example.com/tenant/v1/load");
      expect(cfg.lifecycleExplicit).toBe(false);
      expect(cfg.configSource.lifecycleBase).toBe("process.env(RUKE_LIFECYCLE_BASE) (path prefix preserved)");
      expect(cfg.configSource.unloadUrl).toBe("derived(process.env(RUKE_LIFECYCLE_BASE) (path prefix preserved))");
      expect(cfg.configSource.reloadUrl).toBe("derived(process.env(RUKE_LIFECYCLE_BASE) (path prefix preserved))");
    } finally {
      delete process.env.RUKE_LIFECYCLE_BASE;
    }
  });

  it("without RUKE_LIFECYCLE_BASE the lifecycle pair stays root-mounted and says why", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ llm_api_url: CHAT }));
    });
    cleanups.push(dir);
    const m = await loadSettingsAt(dir);
    const cfg = m.providerConfig();
    expect(cfg.lifecycleBase).toBe("");
    expect(cfg.unloadUrl).toBe("http://127.0.0.1:9099/unload");
    expect(cfg.reloadUrl).toBe("http://127.0.0.1:9099/load");
    expect(cfg.configSource.lifecycleBase).toContain("root-mounted");
    expect(cfg.configSource.unloadUrl).toBe(`derived(${cfg.configSource.controlOrigin})`);
  });

  it("an explicit lifecycle URL still wins verbatim over a configured base", async () => {
    const dir = sandbox();
    cleanups.push(dir);
    process.env.LLM_API_URL = "http://127.0.0.1:8080/v1/chat/completions";
    process.env.RUKE_LIFECYCLE_BASE = "http://127.0.0.1:8080/v1";
    process.env.LLM_UNLOAD_URL = "http://127.0.0.1:8080/legacy-shutdown";
    try {
      const m = await loadSettingsAt(dir);
      const cfg = m.providerConfig();
      expect(cfg.unloadUrl).toBe("http://127.0.0.1:8080/legacy-shutdown");
      expect(cfg.reloadUrl).toBe("http://127.0.0.1:8080/v1/load");
      expect(cfg.lifecycleExplicit).toBe(true);
      expect(cfg.configSource.unloadUrl).toBe("process.env(LLM_UNLOAD_URL)");
    } finally {
      delete process.env.LLM_API_URL;
      delete process.env.RUKE_LIFECYCLE_BASE;
      delete process.env.LLM_UNLOAD_URL;
    }
  });

  it("the automatic handoff is a deployment property, not an acceptance flag", async () => {
    const dir = sandbox((d) => {
      fs.writeFileSync(path.join(d, ".env.local"), `LLM_API_URL=${CHAT}\n`);
    });
    cleanups.push(dir);
    const on = await loadSettingsAt(dir);
    expect(on.providerConfig().automaticHandoff).toBe(true);

    process.env.RUKE_LLM_AUTOMATIC_HANDOFF = "0";
    try {
      const off = await loadSettingsAt(dir);
      expect(off.providerConfig().automaticHandoff).toBe(false);
    } finally {
      delete process.env.RUKE_LLM_AUTOMATIC_HANDOFF;
    }

    process.env.RUKE_OCR_ALLOW_UNLOAD = "0";
    try {
      const legacy = await loadSettingsAt(dir);
      expect(legacy.providerConfig().automaticHandoff).toBe(false);
    } finally {
      delete process.env.RUKE_OCR_ALLOW_UNLOAD;
    }
  });

  it("nothing configured still resolves, with no personal absolute path", async () => {
    const dir = sandbox();
    cleanups.push(dir);
    const m = await loadSettingsAt(dir);
    const cfg = m.providerConfig();
    expect(cfg.chatUrl).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(cfg.configSource.chatUrl).toBe("fallback(LLM_API_URL)");
    expect(cfg.unloadUrl).toBe("http://127.0.0.1:8080/unload");
  });
});
