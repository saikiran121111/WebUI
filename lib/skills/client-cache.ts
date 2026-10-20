/**
 * Shared browser-side cache for GET /api/skills.
 *
 * Two ChatInput instances (hero + bar) each fetched the roster on mount, and
 * swapping hero↔bar remounted them — 2–4 identical GETs back-to-back per page
 * load and per first turn. This module collapses concurrent callers onto ONE
 * in-flight request and serves a short-TTL cache; any mutation (install /
 * scenario save / delete) invalidates it so the next read is always fresh.
 */
import type { SkillRecord } from "./types";

const TTL_MS = 30_000;

let inflight: Promise<SkillRecord[]> | null = null;
let cachedList: SkillRecord[] | null = null;
let cachedAt = 0;

export function fetchSkills(force = false): Promise<SkillRecord[]> {
  if (!force) {
    if (inflight) return inflight;
    if (cachedList && Date.now() - cachedAt < TTL_MS) return Promise.resolve(cachedList);
  }
  inflight = fetch("/api/skills")
    .then((r) => (r.ok ? r.json() : { skills: [] }))
    .then((data) => {
      const list: SkillRecord[] = Array.isArray(data?.skills) ? data.skills : [];
      cachedList = list;
      cachedAt = Date.now();
      return list;
    })
    .catch(() => cachedList ?? [])
    .finally(() => { inflight = null; });
  return inflight;
}

/** Drop the cached roster — call after any skills mutation. */
export function invalidateSkills(): void {
  cachedAt = 0;
  cachedList = null;
}
