import { NextRequest, NextResponse } from "next/server";
import {
  getConversationOnDisk,
  saveConversationOnDisk,
  deleteConversationOnDisk,
} from "../../../../lib/persistence/disk";
import { removeIndex } from "../../../../lib/server/attachindex/store";
import { rustEnabled, rustProxy } from "../../../../lib/server/rustProxy";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (rustEnabled()) return rustProxy(req, `/api/ruke/conversations/${encodeURIComponent(params.id)}`);
  const raw = getConversationOnDisk(params.id);
  if (!raw) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(raw, { status: 200, headers: { "content-type": "application/json" } });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  if (rustEnabled()) return rustProxy(req, `/api/ruke/conversations/${encodeURIComponent(params.id)}`);
  const body = await req.text();
  saveConversationOnDisk(params.id, body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  if (rustEnabled()) return rustProxy(req, `/api/ruke/conversations/${encodeURIComponent(params.id)}`);
  // Index GC: an indexed attachment's knowledge index lives under
  // .data/attach-index/<attId>/ — it must die with the conversation that
  // references it. The att ids are collected straight from the stored JSON
  // (removeIndex tolerates unknown/malformed ids and never throws).
  const raw = getConversationOnDisk(params.id);
  if (raw) {
    const ids = new Set(raw.match(/att_[a-z0-9]{4,32}/g) ?? []);
    for (const id of ids) removeIndex(id);
  }
  deleteConversationOnDisk(params.id);
  return NextResponse.json({ ok: true });
}