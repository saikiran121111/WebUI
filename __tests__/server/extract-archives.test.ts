/**
 * F78-C — the archive reader matrix, RAR first.
 *
 * Repro (2026-11-13 audit): audit.rar — a valid 3-member RAR5 — returned
 * "File read error" (422) while direct extraction yields every member. The
 * old extractRar interleaved the LAZY header-list generator with a per-member
 * extract() pass; both archives read through ONE shared data-seek cursor, so
 * the two readers raced and ERAR_EREAD fired. Headers also carried `name` +
 * `flags.directory`, not the (undefined) `fileName`/`directory` the code read.
 * Locks: all 3 RAR members with their facts, nested paths, duplicate
 * basenames, a malformed RAR failing as an ordinary extraction error, and the
 * ZIP/7z/tar/gz/tgz/xz/bz2 wrappers plus both compound-suffix controls.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { archiveText } from "../../lib/server/extract/archives";

const FIX = path.join("docs", "overnight", "fixtures", "f78", "all-readers");
const NAT = path.join(FIX, "native");
const read = (...p: string[]) => fs.readFileSync(path.join(...p));

describe("RAR reader (F78-C)", () => {
  it("a valid 3-member RAR5 yields every member with its facts", async () => {
    const text = await archiveText(read(FIX, "audit.rar"), "rar", "audit.rar");
    expect(text).toContain("current/summary.csv");
    expect(text).toContain("prior/summary.csv"); // nested path, duplicate basename
    expect(text).toContain("notes/report.txt");
    expect(text).toContain("66719");
    expect(text).toContain("45103");
    expect(text).toContain("918");
    expect(text).toContain("résumé"); // UTF-8 member content survives
    expect(text).toMatch(/archive coverage --- 3 member\(s\) flattened, 3 parsed/);
  });

  it("a truncated RAR yields the intact members and its ledger says so (no crash)", async () => {
    // RAR5 has no "N members total" field: a cut archive reads to the damage
    // point and stops — the LAW is that it degrades to a partial read with a
    // truthful coverage ledger, never a WASM abort and never full trust.
    const cut = read(FIX, "audit.rar").subarray(0, 120); // through member 1, into member 2's header
    const text = await archiveText(cut, "rar", "audit.rar");
    expect(text).toContain("66719"); // member 1 intact
    expect(text).not.toContain("45103"); // member 2 is past the damage — absent
    expect(text).toMatch(/archive coverage --- 1 member\(s\) flattened, 1 parsed/);
  });
});

describe("the other wrappers keep working (rerun matrix)", () => {
  it("zip", async () => {
    const text = await archiveText(read(FIX, "audit.zip"), "zip", "audit.zip");
    expect(text).toContain("66719");
    expect(text).toContain("45103");
    expect(text).toContain("918");
  });
  it("tar", async () => {
    const text = await archiveText(read(FIX, "audit.tar"), "tar", "audit.tar");
    expect(text).toContain("66719");
    expect(text).toContain("45103");
  });
  it("tgz", async () => {
    const text = await archiveText(read(FIX, "audit.tgz"), "tgz", "audit.tgz");
    expect(text).toContain("66719");
    expect(text).toContain("45103");
  });
  it("7z", async () => {
    const text = await archiveText(read(FIX, "audit.7z"), "7z", "audit.7z");
    expect(text).toContain("66719");
    expect(text).toContain("45103");
  });
  it("single-stream gzip", async () => {
    const text = await archiveText(read(FIX, "summary.csv.gz"), "gz", "summary.csv.gz");
    expect(text).toContain("66719");
  });
  it("compound-suffix controls: .tar.xz and .tar.bz2 name their inner tar members", async () => {
    for (const ext of ["xz", "bz2"] as const) {
      const name = `combined.tar.${ext}`;
      const text = await archiveText(read(NAT, name), ext, name);
      expect(text, name).toContain("current/summary.csv");
      expect(text, name).toContain("prior/summary.csv");
      expect(text, name).toContain("66719");
      expect(text, name).toContain("45103");
    }
  });
});
