import { NextRequest, NextResponse } from "next/server";
import {
  listConversationsOnDisk,
  getConversationOnDisk,
  saveConversationOnDisk,
  deleteConversationOnDisk,
} from "../../../lib/persistence/disk";

export async function GET() {
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
  const body = await req.json();
  // Body: { id, json: stringified Conversation }
  if (!body.id || typeof body.json !== "string") {
    return NextResponse.json({ error: "id and json required" }, { status: 400 });
  }
  saveConversationOnDisk(body.id, body.json);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteConversationOnDisk(id);
  return NextResponse.json({ ok: true });
}
