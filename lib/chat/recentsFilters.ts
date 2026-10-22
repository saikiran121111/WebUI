import type { ConversationMeta } from "../types";

/**
 * Pure filtering / grouping / sorting + persistence for the sidebar Recents
 * list (Claude-desktop parity: Status, Last activity, Group by, Sort by).
 * All date math uses local calendar days so "Today" matches the Date group.
 */

export type RecentsStatus = "all" | "active" | "archived";
export type RecentsActivity = "all" | "today" | "7d" | "30d";
export type RecentsGroup = "none" | "pinned" | "date";
export type RecentsSort = "updated" | "created" | "title";

export interface RecentsFilters {
  status: RecentsStatus;
  activity: RecentsActivity;
  group: RecentsGroup;
  sort: RecentsSort;
  /** Groups filter: "all" or an exact group name (free-form string — group
   *  entities are just names on the conversation meta). */
  groupFilter: string;
}

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

// Defaults preserve the pre-filter sidebar behavior (status "all" keeps the
// Archived disclosure; group "pinned" keeps the Pinned/Recent headers), so
// existing conversation flows — archive → unarchive — stay reachable via the
// UI without touching the menu.
export const DEFAULT_RECENTS_FILTERS: RecentsFilters = {
  status: "all",
  activity: "all",
  group: "pinned",
  sort: "updated",
  groupFilter: "all",
};

export const STATUS_OPTIONS: FilterOption<RecentsStatus>[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];
export const ACTIVITY_OPTIONS: FilterOption<RecentsActivity>[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Past 7 days" },
  { value: "30d", label: "Past 30 days" },
];
export const GROUP_OPTIONS: FilterOption<RecentsGroup>[] = [
  { value: "none", label: "None" },
  { value: "pinned", label: "Pinned" },
  { value: "date", label: "Date" },
];
export const SORT_OPTIONS: FilterOption<RecentsSort>[] = [
  { value: "updated", label: "Last activity" },
  { value: "created", label: "Newest" },
  { value: "title", label: "Title (A–Z)" },
];

export function optionLabel<T extends string>(
  options: FilterOption<T>[], value: T,
): string {
  return options.find(o => o.value === value)?.label ?? "";
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Unique, sorted group names present in the store. */
export function listGroups(conversations: ConversationMeta[]): string[] {
  return [...new Set(conversations.map(c => c.group).filter((g): g is string => !!g))]
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Claude-style relative activity label for the Recents modal rows:
 * "Just now" / "22 hours ago" / "3 days ago", then a medium date
 * ("Aug 27, 2025") past a week.
 */
export function formatActivityLabel(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const hrs = Math.floor(diff / HOUR_MS);
  if (hrs < 1) return "Just now";
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

/** Local midnight for a timestamp. */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Cutoff for an activity window: N calendar days back from local midnight. */
function activityCutoff(activity: RecentsActivity): number | null {
  if (activity === "all") return null;
  const today = dayStart(Date.now());
  if (activity === "today") return today;
  if (activity === "7d") return today - 6 * DAY_MS;
  return today - 29 * DAY_MS;
}

/** Status + activity + title search, then sort — order of the main list. */
export function filterConversations(
  conversations: ConversationMeta[],
  filters: RecentsFilters,
  query: string,
): ConversationMeta[] {
  const q = query.trim().toLowerCase();
  const cutoff = activityCutoff(filters.activity);
  const list = conversations.filter(c => {
    if (filters.status === "active" && c.archived) return false;
    if (filters.status === "archived" && !c.archived) return false;
    if (filters.groupFilter !== "all" && (c.group ?? "") !== filters.groupFilter) return false;
    if (cutoff !== null && c.updatedAt < cutoff) return false;
    if (q && !c.title.toLowerCase().includes(q)) return false;
    return true;
  });
  switch (filters.sort) {
    case "created": return [...list].sort((a, b) => b.createdAt - a.createdAt);
    case "title": return [...list].sort((a, b) => a.title.localeCompare(b.title));
    default: return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export interface RecentsSection {
  key: string;
  /** null = no section header. */
  label: string | null;
  items: ConversationMeta[];
}

/**
 * Group the non-archived pool (or the archived pool when status="archived").
 * "pinned" reproduces the legacy Pinned / Recent (or Chats) headers.
 */
export function groupConversations(
  items: ConversationMeta[],
  group: RecentsGroup,
): RecentsSection[] {
  if (items.length === 0) return [];

  if (group === "pinned") {
    const pinned = items.filter(c => c.pinned);
    const rest = items.filter(c => !c.pinned);
    const sections: RecentsSection[] = [];
    if (pinned.length > 0) sections.push({ key: "pinned", label: "Pinned", items: pinned });
    if (rest.length > 0) {
      sections.push({
        key: "rest",
        label: pinned.length > 0 ? "Recent" : "Chats",
        items: rest,
      });
    }
    return sections;
  }

  if (group === "date") {
    const today = dayStart(Date.now());
    const buckets: { key: string; label: string; cutoff: number }[] = [
      { key: "today", label: "Today", cutoff: today },
      { key: "yesterday", label: "Yesterday", cutoff: today - DAY_MS },
      { key: "week", label: "Past 7 days", cutoff: today - 6 * DAY_MS },
      { key: "earlier", label: "Earlier", cutoff: -Infinity },
    ];
    const sections: RecentsSection[] = [];
    for (const b of buckets) {
      const inBucket = items.filter(c => c.updatedAt >= b.cutoff);
      if (inBucket.length > 0) sections.push({ key: b.key, label: b.label, items: inBucket });
    }
    return sections;
  }

  return [{ key: "all", label: null, items }];
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

const FILTERS_KEY = "ruke.recents.filters";
const COLLAPSED_KEY = "ruke.recents.collapsed";

function validValue<T extends string>(opts: FilterOption<T>[], v: unknown, fallback: T): T {
  return opts.some(o => o.value === v) ? (v as T) : fallback;
}

export function loadRecentsFilters(): RecentsFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_RECENTS_FILTERS;
    const p = JSON.parse(raw) as Partial<RecentsFilters>;
    return {
      status: validValue(STATUS_OPTIONS, p.status, DEFAULT_RECENTS_FILTERS.status),
      activity: validValue(ACTIVITY_OPTIONS, p.activity, DEFAULT_RECENTS_FILTERS.activity),
      group: validValue(GROUP_OPTIONS, p.group, DEFAULT_RECENTS_FILTERS.group),
      sort: validValue(SORT_OPTIONS, p.sort, DEFAULT_RECENTS_FILTERS.sort),
      // Free-form group name: Sidebar re-validates it against the store so a
      // deleted group can never leave the list permanently empty.
      groupFilter: typeof p.groupFilter === "string" && p.groupFilter ? p.groupFilter : "all",
    };
  } catch {
    return DEFAULT_RECENTS_FILTERS;
  }
}

export function saveRecentsFilters(f: RecentsFilters): void {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* private mode */ }
}

export function loadRecentsCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

export function saveRecentsCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* private mode */ }
}
