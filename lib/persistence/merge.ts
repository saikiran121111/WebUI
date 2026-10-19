/**
 * Title-ownership merge for whole-document saves (POST /api/conversations).
 *
 * The sidebar's persist effect writes the FULL document, and its `existing`
 * meta comes from a possibly-stale list snapshot — without this merge a save
 * that races a finished title job would clobber the new server-written title
 * with the old first-message copy. Rule:
 *   - incoming titleSource === "manual" (a user rename) → incoming wins;
 *   - otherwise the STORED title fields survive — auto titles are server-owned.
 */
export function mergeProtectedTitle(storedRaw: string | null, incomingJson: string): string {
  if (!storedRaw) return incomingJson;
  try {
    const stored = JSON.parse(storedRaw);
    const incoming = JSON.parse(incomingJson);
    if (!incoming?.meta) return incomingJson;
    if (incoming.meta.titleSource === "manual") return incomingJson;
    if (stored?.meta?.title) {
      incoming.meta.title = stored.meta.title;
      for (const k of ["titleSource", "titleGenCount", "titleGenAt"] as const) {
        if (stored.meta[k] !== undefined) incoming.meta[k] = stored.meta[k];
      }
    }
    return JSON.stringify(incoming);
  } catch {
    return incomingJson; // unparseable — fall through to the original write path
  }
}
