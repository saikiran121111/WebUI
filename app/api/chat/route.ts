import { NextRequest, NextResponse } from "next/server";

const LLM_API_URL = process.env.LLM_API_URL || "http://127.0.0.1:8080/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY || "no-key";

export async function POST(req: NextRequest) {
  const body = await req.json();

  try {
    const upstreamRes = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error(`Upstream error ${upstreamRes.status}:`, errText);
      return NextResponse.json(
        { error: `LLM server returned ${upstreamRes.status}: ${errText.slice(0, 200)}` },
        { status: upstreamRes.status }
      );
    }

    if (!upstreamRes.body) {
      return NextResponse.json({ error: "No response body from upstream" }, { status: 502 });
    }

    // Stream the response directly to the client
    return new NextResponse(upstreamRes.body, {
      headers: {
        "Content-Type": upstreamRes.headers.get("Content-Type") || "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Proxy error:", message);
    return NextResponse.json(
      { error: "Could not connect to the model server. Make sure llama.cpp is running on port 8080." },
      { status: 503 }
    );
  }
}
