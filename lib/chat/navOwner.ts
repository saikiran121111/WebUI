/**
 * F153 (2026-11-24) — the NAVIGATION-OWNERSHIP law, §1 data loss.
 *
 * Opening a chat is async: app/page.tsx's handleSelect awaits
 * getConversation(id) (IndexedDB). The 2026-11-24 audit found the await
 * unguarded, so the LAST RESOLVER owned the screen, not the latest
 * navigation:
 *  - open slow A, then fast B — B paints, then A's late resolve overwrites
 *    it: the user is looking at a chat they left, and the sidebar says so
 *    (setActiveId(A));
 *  - New while A loads — clear() paints the fresh chat, then A's late
 *    resolve reloads it over the New chat;
 *  - the late load also rewires the model-facing history, so B's next
 *    request carries A's conversation.
 *
 * The law: the LATEST navigation owns the screen. Every navigation (select
 * AND New) takes a generation; a resolved load acts only while its
 * generation is still current, else it is discarded whole — no load, no
 * setActiveId, no badge write. Trivial by construction; the point is that
 * the page's async owner consults it around every await.
 */
export interface NavOwner {
  /** Take the screen for a new navigation; returns its generation token. */
  begin(): number;
  /** Cancel ownership (a navigation with no async tail, e.g. New). */
  cancel(): void;
  /** Is this generation still the latest navigation? */
  isCurrent(gen: number): boolean;
}

export function createNavOwner(): NavOwner {
  let gen = 0;
  return {
    begin: () => ++gen,
    cancel: () => { gen++; },
    isCurrent: (g: number) => g === gen,
  };
}
