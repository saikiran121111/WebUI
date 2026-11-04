import { NextRequest, NextResponse } from "next/server";
import {
  listConversationsOnDisk,
  getConversationOnDisk,
  saveConversationOnDisk,
} from "../../../lib/persistence/disk";
import { mergeProtectedTitle } from "../../../lib/persistence/merge";
import { rustEnabled, rustProxy } from "../../../lib/server/rustProxy";

// Optional `req` exists only for the Part-8 proxy branch; direct callers
// (vitest goldens) keep working argument-less.
export async function GET(req?: NextRequest) {
  if (rustEnabled() && req) return rustProxy(req, "/api/ruke/conversations");
  const items = listConversationsOnDisk();
  // Enrich with parsed metadata so the sidebar doesn't have to parse JSON.
  const result = items
    .map(({ id, updatedAt }) => {
      try {
        const raw = getConversationOnDisk(id);
        if (!raw) return null;
        const doc = JSON.parse(raw);
        const meta = doc.meta;
        if (!meta) return null;
        return { id, updatedAt, meta };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  if (rustEnabled()) return rustProxy(req, "/api/ruke/conversations");
  const body = await req.json();
  // Body: { id, json: stringified Conversation }
  if (!body.id || typeof body.json !== "string") {
    return NextResponse.json({ error: "id and json required" }, { status: 400 });
  }
  // Auto titles are server-owned: a whole-document save from the sidebar (its
  // meta may predate a finished title job) keeps the STORED title unless the
  // save explicitly marks the title manual (a user rename). See merge.ts.
  const storedRaw = getConversationOnDisk(body.id);
  saveConversationOnDisk(body.id, mergeProtectedTitle(storedRaw, body.json));
  return NextResponse.json({ ok: true });
}
