/**
 * P5B ZIP consolidation gate.
 *
 * There was no unit coverage for the extraction path before fflate replaced
 * the hand-rolled EOCD/central-directory reader in lib/server/extract/zip.ts.
 * Every behavior asserted here was FIRST measured on fflate 0.8.3 with throw-
 * away probes (2026-11-06) — these tests lock the verified contract down:
 * mixed methods, real-Zip64 full reads, no CRC verification, the oversize-
 * member drop, and the bundled-7za fallback for containers fflate refuses.
 *
 * The fixture-backed cases drive the product's real upload entry point
 * (extractFileFromPath); they skip cleanly until `node scripts/make-fixtures.mjs`
 * has been run (fixtures are generated and git-ignored by design).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { extractFileFromPath } from "../../lib/server/extract";
import { archiveText } from "../../lib/server/extract/archives";
import { MAX_MEMBER_INFLATED_BYTES, readZip } from "../../lib/server/extract/zip";

const execFileP = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const SCRATCH = fs.mkdtempSync(path.join(ROOT, ".data", "tmp", "zt_"));

const marker = (tag: string) => `READABLE-MARKER-${tag}-7QX9`;

async function sevenExe(): Promise<string> {
  const seven: any = await import("7zip-bin");
  const exe: string = seven.path7za ?? seven.default?.path7za;
  if (!exe || !fs.existsSync(exe)) {
    throw new Error("Bundled 7za binary is missing — run `npm install`");
  }
  return exe;
}

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("readZip — fflate reader contract", () => {
  it("reads stored AND deflated members with exact names and bytes", () => {
    const buf = Buffer.from(zipSync({
      "store.txt": [strToU8("STORED-BODY-4KX"), { level: 0 }],
      "nested dir/defl.txt": [strToU8("deflated body ".repeat(80)), { level: 9 }],
    }));
    // The archive genuinely mixes methods 0 and 8: the stored body is visible
    // verbatim in the bytes, the deflated one is not.
    expect(buf.includes(Buffer.from("STORED-BODY-4KX"))).toBe(true);
    expect(buf.includes(Buffer.from("deflated body deflated body"))).toBe(false);

    const entries = readZip(buf);
    expect(entries.map((e) => e.name).sort()).toEqual(["nested dir/defl.txt", "store.txt"]);
    const stored = entries.find((e) => e.name === "store.txt")!;
    expect(stored.data.toString("utf8")).toBe("STORED-BODY-4KX");
    expect(entries.find((e) => e.name === "nested dir/defl.txt")!.data.toString("utf8"))
      .toBe("deflated body ".repeat(80));
  });

  it("wraps unparseable input in the reader error contract", () => {
    expect(() => readZip(Buffer.from("definitely not a zip archive"))).toThrow(
      /Not a readable ZIP file/,
    );
  });

  it("ignores declared member sizes and inflates the real stream (fflate does not check CRCs)", () => {
    // A tampered archive lying that a 64 MiB member is 4 KiB must NOT truncate
    // to 4 KiB — fflate inflates to the real deflate stream end and never
    // validates the CRC. That is exactly why MAX_MEMBER_INFLATED_BYTES filters
    // the INFLATED length instead of any declared length.
    const REAL = 64 * 1024 * 1024;
    const buf = Buffer.from(zipSync({
      "lie.bin": new Uint8Array(REAL),
      "keep.txt": strToU8("survivor"),
    }, { level: 9 }));
    let cd = -1;
    for (let i = buf.length - 4; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x02014b50) { cd = i; break; }
    }
    expect(cd).toBeGreaterThan(-1);
    buf.writeUInt32LE(4096, cd + 24); // central-dir uncompressed size -> lie
    for (let i = 0; ; i++) {          // local headers -> same lie
      const lh = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i);
      if (lh < 0) break;
      buf.writeUInt32LE(4096, lh + 18);
      buf.writeUInt32LE(4096, lh + 22);
      i = lh + 3;
    }
    const entries = readZip(buf);
    const lie = entries.find((e) => e.name === "lie.bin")!;
    expect(lie.data.length).toBe(REAL);
    expect(entries.find((e) => e.name === "keep.txt")!.data.toString("utf8")).toBe("survivor");
  }, 120_000);

  it("drops members over MAX_MEMBER_INFLATED_BYTES instead of failing the container", () => {
    const buf = Buffer.from(zipSync({
      "big.bin": new Uint8Array(MAX_MEMBER_INFLATED_BYTES + 1024 * 1024),
      "small.txt": strToU8("keep me"),
    }, { level: 9 }));
    const entries = readZip(buf);
    expect(entries.map((e) => e.name)).toEqual(["small.txt"]);
    expect(entries[0].data.toString("utf8")).toBe("keep me");
  }, 180_000);

  it("still flattens nested zip members inside an outer zip", async () => {
    const inner = Buffer.from(zipSync({ "DEEP.txt": strToU8("NESTED-ZIP-DEEP-M7P") }));
    const outer = Buffer.from(zipSync({
      "top.txt": strToU8("outer top text"),
      "inner.zip": inner,
    }));
    const text = await archiveText(outer, "zip");
    expect(text).toContain("outer top text");
    expect(text).toContain("NESTED-ZIP-DEEP-M7P");
  });
});

describe("Zip64 and the 7za fallback", () => {
  let zip64: Buffer | null = null;

  beforeAll(async () => {
    // A genuine >65,535-entry Zip64 archive from a spec-compliant producer
    // (7za): legacy 16-bit count field = 0xFFFF marker + EOCD64 + locator.
    // fflate's OWN writer cannot produce this (a plain zipSync of 66k members
    // overflows the count field — measured; never hand the app >65k-member
    // archives to write), so 7za is the only honest fixture builder here.
    const exe = await sevenExe();
    const dir = path.join(SCRATCH, "z64");
    fs.mkdirSync(dir, { recursive: true });
    const list: string[] = [];
    for (let i = 0; i < 66000; i++) {
      fs.writeFileSync(path.join(dir, `m${i}.bin`), "x" + i);
      list.push(`m${i}.bin`);
    }
    fs.writeFileSync(path.join(dir, "MARKER-65000.txt"), "ZIP64-TAIL-MEMBER-K9Q");
    list.push("MARKER-65000.txt");
    fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n"));
    await execFileP(exe, ["a", "-tzip", "big.zip", "@list.txt"], {
      cwd: dir,
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    zip64 = fs.readFileSync(path.join(dir, "big.zip"));
  }, 420_000);

  it("reads a genuine 66k-member Zip64 archive back IN FULL (the hand-rolled parser capped at 65,535)", () => {
    const entries = readZip(zip64!);
    expect(entries.length).toBe(66001);
    const tail = entries.find((e) => e.name === "MARKER-65000.txt");
    expect(tail?.data.toString("utf8")).toBe("ZIP64-TAIL-MEMBER-K9Q");
  }, 120_000);

  it("surfaces the LAST member of a Zip64 archive through the archive reader", async () => {
    const text = await archiveText(zip64!, "zip");
    expect(text).toContain("ZIP64-TAIL-MEMBER-K9Q");
  }, 120_000);

  it("falls back to the bundled 7za when fflate refuses a valid non-deflate method (LZMA)", async () => {
    const exe = await sevenExe();
    const dir = path.join(SCRATCH, "lzma");
    fs.mkdirSync(dir, { recursive: true });
    // The member MUST be compressible: measured on 7zip-bin 5.2.0, 7za writes
    // method 0 (STORE) into the CD when LZMA would not shrink the member (a
    // 25-byte source did exactly that), and then fflate happily reads it and
    // there is nothing to fall back from. Repetitive text keeps method 14.
    fs.writeFileSync(
      path.join(dir, "lz-src.txt"),
      "LZMA-VIA-7ZA-FALLBACK-Q3X " + "compressible padding text ".repeat(200),
    );
    // cwd + relative paths: absolute member paths would nest under a drive-letter dir.
    await execFileP(exe, ["a", "-tzip", "-mm=lzma", "lz.zip", "lz-src.txt"], { cwd: dir, timeout: 60_000 });
    const buf = fs.readFileSync(path.join(dir, "lz.zip"));
    expect(() => readZip(buf)).toThrow(/Not a readable ZIP file/);
    const text = await archiveText(buf, "zip");
    expect(text).toContain("LZMA-VIA-7ZA-FALLBACK-Q3X");
  }, 120_000);

  it("fails a password-protected zip honestly (7za also refuses without the password)", async () => {
    const exe = await sevenExe();
    const dir = path.join(SCRATCH, "enc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "enc-src.txt"), "encrypted zip member text");
    // Throwaway fixture passphrase generated at runtime — no secret is stored
    // in this file (CLAUDE.md §7); 7za needs it on argv for the fixture only.
    const pw = "fixture-" + randomBytes(4).toString("hex");
    await execFileP(exe, ["a", "-tzip", `-p${pw}`, "-mem=AES256", "enc.zip", "enc-src.txt"], { cwd: dir, timeout: 60_000 });
    const buf = fs.readFileSync(path.join(dir, "enc.zip"));
    await expect(archiveText(buf, "zip")).rejects.toThrow(/password/i);
  }, 120_000);
});

const haveFixtures = fs.existsSync(path.join(FIXTURES, "fixture-archive.zip"));

describe.skipIf(!haveFixtures)("extraction through the real entry points (needs `node scripts/make-fixtures.mjs`)", () => {
  it("reads the regenerated fixture-archive.zip through extractFileFromPath", async () => {
    const src = path.join(SCRATCH, "fixture-archive.zip");
    fs.copyFileSync(path.join(FIXTURES, "fixture-archive.zip"), src);
    const r = await extractFileFromPath("fixture-archive.zip", src);
    expect(r.category).toBe("archive");
    expect(r.text).toContain(marker("ZIP"));
    expect(r.text).toContain("data/notes.md");
  }, 60_000);

  it("reads every regenerated Office/ODF/EPUB container through extractFileFromPath", async () => {
    const cases: [string, string][] = [
      ["fixture-doc.docx", "DOCX"],
      ["fixture-sheet.xlsx", "XLSX"],
      ["fixture-sheet.xlsm", "XLSM"],
      ["fixture-slides.pptx", "PPTX"],
      ["fixture-office.odt", "ODT"],
      ["fixture-office.ods", "ODS"],
      ["fixture-office.odp", "ODP"],
      ["fixture-book.epub", "EPUB"],
    ];
    for (const [file, tag] of cases) {
      const src = path.join(SCRATCH, file);
      fs.copyFileSync(path.join(FIXTURES, file), src);
      const r = await extractFileFromPath(file, src);
      expect(r.text, `${file} lost its marker after the fflate consolidation`).toContain(
        `Marker: ${marker(tag)}`,
      );
    }
  }, 60_000);

  it("regression: the non-zip archive formats still read", async () => {
    const cases: [string, string][] = [
      ["fixture-archive.tar", "tar"],
      ["fixture-archive.tgz", "tgz"],
      ["fixture-notes.gz", "gz"],
      ["fixture-archive.tar.xz", "xz"],
      ["fixture-notes.txt.bz2", "bz2"],
      ["fixture-archive.7z", "7z"],
    ];
    for (const [file, ext] of cases) {
      const buf = fs.readFileSync(path.join(FIXTURES, file));
      const text = await archiveText(buf, ext, file);
      expect(text, `${file} no longer reads`).toContain("READABLE-MARKER-");
    }
  }, 180_000);
});
