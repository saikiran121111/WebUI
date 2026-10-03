import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q");
  if (!query) return NextResponse.json({ results: [] });

  try {
    const url = new URL("http://127.0.0.1:8888/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("engines", "google,duckduckgo,brave,wikipedia");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error("SearXNG returned " + res.status);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    return NextResponse.json({ error: "Search unavailable", results: [] }, { status: 502 });
  }
}
