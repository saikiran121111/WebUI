import { NextRequest, NextResponse } from "next/server";
import {
  getConversationOnDisk,
  saveConversationOnDisk,
  deleteConversationOnDisk,
} from "../../../../lib/persistence/disk";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const raw = getConversationOnDisk(params.id);
  if (!raw) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(raw, { status: 200, headers: { "content-type": "application/json" } });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.text();
  saveConversationOnDisk(params.id, body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  deleteConversationOnDisk(params.id);
  return NextResponse.json({ ok: true });
}