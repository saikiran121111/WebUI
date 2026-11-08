import { describe, expect, it, vi } from "vitest";

/**
 * I14: the default whisper checkpoint (".en") is ENGLISH-ONLY. A Hindi
 * recording used to surface as "no speech" with zero explanation. The
 * capability note must exist for .en checkpoints and vanish for
 * multilingual ones (where the caveat would be a lie).
 */

const load = () => import("../../lib/server/extract/audio");

describe("asrCapabilityNote (I14)", () => {
  it("English-only default checkpoint → honest, actionable note", async () => {
    const audio = await load();
    expect(audio.asrModelLabel()).toMatch(/\.en$/);
    const note = audio.asrCapabilityNote();
    expect(note).toBeTruthy();
    expect(note).toContain("English-only");
    expect(note).toContain(audio.asrModelLabel());
    expect(note).toContain("WHISPER_MODEL");
    expect(note).toContain("Xenova/whisper-base");
  });

  it("multilingual checkpoint → empty note (no false caveat)", async () => {
    vi.resetModules();
    vi.stubEnv("WHISPER_MODEL", "Xenova/whisper-base");
    try {
      const audio = await load();
      expect(audio.asrModelLabel()).toBe("Xenova/whisper-base");
      expect(audio.asrCapabilityNote()).toBe("");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
