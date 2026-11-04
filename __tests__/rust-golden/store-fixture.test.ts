/**
 * Cross-language store fixture (MIGRATION-MAP Part 5 §27).
 *
 * Commits the EXACT bytes the PRODUCTION Node writer (`writeIndex` + the
 * golden frame writes in ./support/attach-seeds) puts on disk for the
 * attachment indexes, so the Rust side (`ruke-attach`) can open a store it
 * did not create — the Node side never reconstructs these files by hand and
 * the Rust tests copy them VERBATIM.
 *
 * Modes:
 *  - Re-record:  RUKE_WRITE_STORE_FIXTURE=1 npx vitest run ^
 *                  __tests__/rust-golden/store-fixture.test.ts
 *    Seeds via the production writer (into the live cwd-pinned
 *    `.data/attach-index`, exactly like the app), copies the resulting tree
 *    byte-for-byte into `rust-backend/fixtures/attachments/store/<attId>/`,
 *    then removes the scratch store (removeIndex).
 *  - Default (drift guard): regenerates into the scratch store and byte-
 *    compares every committed file. If this fails because the WRITER or the
 *    seeds changed intentionally, DELETE the fixture dir and re-record —
 *    NEVER hand-edit these bytes: the Rust replay tests read them verbatim
 *    and compare against the TS-replay fixtures (attachments.test.ts).
 *
 * `att_golden1b` is intentionally absent (fixture 02 = missing index).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexDir, removeIndex } from "@/lib/server/attachindex/store";
import { ATT_IDS, SEEDED_ATT_IDS, seedAttachmentStore } from "./support/attach-seeds";

const RE_RECORD = process.env.RUKE_WRITE_STORE_FIXTURE === "1";
const FIXTURE_ROOT = path.join("rust-backend", "fixtures", "attachments", "store");

beforeAll(() => {
  for (const id of ATT_IDS) removeIndex(id);
  seedAttachmentStore();
});

afterAll(() => {
  for (const id of ATT_IDS) removeIndex(id);
});

/** Recursive walk: index-dir-relative path (always "/") -> bytes. */
function tree(dir: string, prefix = ""): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, tree(path.join(dir, e.name), rel));
    else out[rel] = fs.readFileSync(path.join(dir, e.name));
  }
  return out;
}

function copyTree(srcDir: string, dstDir: string): void {
  for (const [rel, bytes] of Object.entries(tree(srcDir))) {
    const dst = path.join(dstDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, bytes);
  }
}

describe("cross-language store fixture (production writeIndex bytes)", () => {
  for (const att of SEEDED_ATT_IDS) {
    it(`store bytes recorded verbatim for ${att}`, () => {
      const scratch = indexDir(att);
      if (!fs.existsSync(scratch)) throw new Error(`production writer produced nothing for ${att}`);
      const generated = tree(scratch);
      const wantFiles = ["chunks.jsonl", "full.txt", "meta.json"]
        .concat(att === "att_golden1d" ? ["frames/f_golden1.jpg"] : [])
        .sort();
      if (JSON.stringify(Object.keys(generated).sort()) !== JSON.stringify(wantFiles)) {
        throw new Error(`${att}: unexpected scratch layout — the writer contract changed`);
      }

      const committedDir = path.join(FIXTURE_ROOT, att);
      if (RE_RECORD) {
        fs.rmSync(committedDir, { recursive: true, force: true });
        copyTree(scratch, committedDir);
      }
      const committed = tree(committedDir);
      if (JSON.stringify(Object.keys(committed).sort()) !== JSON.stringify(Object.keys(generated).sort())) {
        throw new Error(`${att}: committed file set differs from the generated scratch store`);
      }
      for (const rel of Object.keys(generated)) {
        if (!committed[rel].equals(generated[rel])) {
          throw new Error(`${att}/${rel} drifted — delete + re-record, never hand-edit`);
        }
      }
    });
  }
});
