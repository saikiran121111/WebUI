import { describe, it, expect, afterEach, vi } from "vitest";
import { saveConversation, updateConversationMeta, SaveError } from "../lib/persistence";

/**
 * I03 — a failed conversation save must THROW, never resolve. The UI's
 * "saved" presentation is only trustworthy if saveConversation rejects on
 * non-2xx, carrying the HTTP status.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function conv(): any {
  return {
    id: "c1",
    meta: { id: "c1", title: "t", createdAt: 1, updatedAt: 1, messageCount: 0 },
    messages: [],
  };
}

describe("saveConversation (I03)", () => {
  it("rejects with SaveError carrying the status on a non-2xx save", async () => {
    const fetchMock = vi.fn(async () => new Response("disk full", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await saveConversation(conv()).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(SaveError);
    expect(err.status).toBe(500);
    expect(err.name).toBe("SaveError");
    expect(String(err.message)).toContain("500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves on a successful save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(saveConversation(conv())).resolves.toBeUndefined();
  });

  it("propagates transport failures instead of swallowing them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(saveConversation(conv())).rejects.toThrow(TypeError);
  });
});

describe("updateConversationMeta (I03)", () => {
  it("propagates a failed meta save (pin/archive/rename must not look successful)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/conversations/c1")) {
          return new Response(JSON.stringify(conv()), { status: 200 });
        }
        return new Response("write refused", { status: 403 });
      }),
    );
    const err = await updateConversationMeta("c1", { title: "new" } as any).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(SaveError);
    expect(err.status).toBe(403);
  });
});
