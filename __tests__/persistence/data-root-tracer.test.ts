/**
 * BUILD-SAFETY REGRESSION (session 50 root cause, see docs/overnight/FINDINGS.md).
 *
 * Mechanism, reproduced by an nft mirror harness plus a 5-way source-shape
 * bisect (evidence described in FINDINGS.md): "next build" traces server
 * dependencies with @vercel/nft, whose static evaluator marks the RAW return
 * value of os.homedir() (and of process.env.X) as an unresolved FILESYSTEM
 * ROOT. Any path built from that marked value becomes an "asset directory",
 * i.e. the recursive glob of the whole user profile, which on Windows dies on
 * the protected junction:
 *   Failed to compile. Error: EPERM: operation not permitted,
 *   scandir 'C:\<user>\Application Data'
 * That is exactly how this repo's production build broke.
 *
 * The load-bearing shape is an assignment of the raw call result to a local
 * that is then fed into path building. Coercing AT THE READ SITE
 * (String(os.homedir?.() ?? "")) removes the marker and keeps the runtime path
 * byte-identical.
 *
 * These are SOURCE greps because the defect only surfaces in a full
 * production build, which no unit test can cheaply re-run.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DATA_ROOT = path.join(process.cwd(), "lib", "persistence", "dataRoot.ts");

/** Drop comment lines: they legitimately name the pattern the code must avoid. */
function code(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("dataRoot tracer-safety shape", () => {
  const src = code(fs.readFileSync(DATA_ROOT, "utf8"));

  it("coerces the home directory at the read site", () => {
    expect(/String\(\s*os\.homedir\?\.\(\)\s*\?\?\s*""\s*\)/.test(src)).toBe(true);
  });

  it("never assigns a raw os.homedir() result to a local", () => {
    // "const h = os.homedir();" is the exact shape the bisect proved dirty.
    expect(/(const|let|var)\s+\w+\s*=\s*os\.homedir\(\s*\)\s*;/.test(src)).toBe(false);
    expect(/=\s*os\.homedir\(\s*\)\s*;/.test(src)).toBe(false);
  });

  it("coerces the env fallbacks instead of reading them raw", () => {
    expect(
      /String\(\s*process\.env\.USERPROFILE\s*\?\?\s*process\.env\.HOME\s*\?\?\s*""\s*\)/.test(src),
    ).toBe(true);
    expect(/path\.(join|resolve)\(\s*process\.env\./.test(src)).toBe(false);
  });

  it("keeps the resolver the single home for persistence modules", () => {
    const disk = code(fs.readFileSync(path.join(process.cwd(), "lib", "persistence", "disk.ts"), "utf8"));
    const journal = code(
      fs.readFileSync(path.join(process.cwd(), "lib", "persistence", "research-journal.ts"), "utf8"),
    );
    for (const [name, text] of [
      ["disk.ts", disk],
      ["research-journal.ts", journal],
    ] as const) {
      expect(text, name).toMatch(/dataRoot/);
      expect(/\bos\.homedir\(/.test(text), name).toBe(false);
      expect(/process\.env\.HOME\b/.test(text), name).toBe(false);
    }
  });
});

describe("no traced module reintroduces a raw root read", () => {
  const offenders: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = code(fs.readFileSync(full, "utf8"));
        if (/(const|let|var)\s+\w+\s*=\s*os\.(homedir|tmpdir)\(\s*\)\s*;/.test(text)) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    }
  }

  it("traced server modules assign no raw homedir/tmpdir result", () => {
    for (const root of ["lib", "app"]) walk(path.join(process.cwd(), root));
    expect(offenders, "raw os.homedir()/os.tmpdir() assignment: " + offenders.join(", ")).toEqual([]);
  });
});
