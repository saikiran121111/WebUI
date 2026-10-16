import { describe, it, expect } from "vitest";
import { buildStoreZip } from "../../lib/three3d/zipWriter";

const enc = new TextEncoder();

describe("buildStoreZip (store-only, dependency-free)", () => {
  it("writes a valid archive: local headers, central directory and EOCD", async () => {
    const entries = [
      { name: "model.obj", data: enc.encode("v 0 0 0\n") },
      { name: "sub/texture.png", data: new Uint8Array([0x89, 0x50, 0x0e, 0x0d]) },
    ];
    const bytes = new Uint8Array(await buildStoreZip(entries).arrayBuffer());
    const view = new DataView(bytes.buffer);

    // Local file header for entry 0.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // method: store
    expect(new TextDecoder().decode(bytes.slice(30, 39))).toBe("model.obj");

    // EOCD in the last 22 bytes, with correct counts and offsets.
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(2);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);

    // Stored data appears verbatim (method 0).
    expect(new TextDecoder().decode(bytes).includes("v 0 0 0")).toBe(true);
  });

  it("stores correct CRC-32 values", async () => {
    const bytes = new Uint8Array(await buildStoreZip([{ name: "a.txt", data: enc.encode("hello") }]).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(14, true)).toBe(0x3610a686); // crc32("hello")
    // Central directory carries the same CRC.
    const cdOffset = view.getUint32(bytes.length - 22 + 16, true);
    expect(view.getUint32(cdOffset + 16, true)).toBe(0x3610a686);
  });

  it("central directory local-header offsets point at the right entries", async () => {
    const a = { name: "a.txt", data: enc.encode("aaa") };
    const b = { name: "bb.txt", data: enc.encode("bbbb") };
    const bytes = new Uint8Array(await buildStoreZip([a, b]).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const cdOffset = view.getUint32(bytes.length - 22 + 16, true);
    const firstCdSize = 46 + a.name.length;
    const bLocalOffset = view.getUint32(cdOffset + firstCdSize + 42, true);
    expect(view.getUint32(bLocalOffset, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(bytes.slice(bLocalOffset + 30, bLocalOffset + 36))).toBe("bb.txt");
  });
});
