const SEARX_URL = "http://127.0.0.1:8888";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  published?: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export async function searchSeax(query: string, timeoutMs = 8000): Promise<SearchResult[]> {
  const url = new URL(SEARX_URL + "/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("engines", "google,duckduckgo,brave,wikipedia");
  url.searchParams.set("language", "en");
  url.searchParams.set("pageno", "1");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) throw new Error("Search returned " + res.status);
    const data: SearchResponse = await res.json();
    return data.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      domain: new URL(r.url).hostname,
      published: (r as any).published || (r as any).pubdate || (r as any).publishedDate || undefined,
    }));
  } finally {
    clearTimeout(timer);
  }
}
