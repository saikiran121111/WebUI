import type { SearchResult } from "../search";
import { searchSeax } from "../search";
import { BrowserTool } from "../browser/agentBrowser";
import type {
  ResearchEvent, ResearchStep, Citation, ToolCall, ChatMode,
} from "../types";

export type ResearchStatus = "idle" | "planning" | "running" | "done" | "failed";

export interface ResearchTask {
  id: string;
  query: string;
  plan: ResearchStep[];
  sources: SearchResult[];
  citations: Citation[];
  status: ResearchStatus;
  events: ResearchEvent[];
  browser: BrowserTool | null;
  error?: string;
}

export class ResearchOrchestrator {
  private browser = new BrowserTool();

  async run(queries: string[], onEvent: (e: ResearchEvent) => void): Promise<ResearchTask> {
    const task: ResearchTask = {
      id: "r_" + Math.random().toString(36).slice(2, 9),
      query: queries[0] ?? "",
      plan: [],
      sources: [],
      citations: [],
      status: "running",
      events: [],
      browser: this.browser,
    };

    onEvent({ type: "notice", level: "info", message: "Research started" });

    for (let i = 0; i < queries.length; i++) {
      onEvent({ type: "step", index: i, status: "active", label: queries[i] });

      try {
        const results = await searchSeax(queries[i], 10000);
        task.sources.push(...results);
        onEvent({ type: "step", index: i, status: "done" });

        // Try to open top results for deeper extraction.
        for (const r of results.slice(0, 2)) {
          onEvent({ type: "tool_call", call: {
            id: "tool_web_open_" + Math.random().toString(36).slice(2, 8),
            name: "web_open",
            args: JSON.stringify({ url: r.url }),
            status: "running",
          }});
          const res = await this.browser.read(r.url);
          onEvent({ type: "tool_result",
            id: "tool_web_open_" + Math.random().toString(36).slice(2, 8),
            status: res.ok ? "ok" : "error",
            summary: res.ok ? "Opened " + r.domain : (res.error ?? "Failed"),
            detail: res.stdout,
          });
        }
      } catch (e: any) {
        onEvent({ type: "step", index: i, status: "failed", label: e?.message ?? "Error" });
        onEvent({ type: "notice", level: "warn", message: "Search failed: " + (e?.message ?? "unknown") });
      }
    }

    // Build citations from collected sources.
    const seen = new Set<string>();
    let n = 0;
    for (const s of task.sources) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      n++;
      task.citations.push({
        n,
        title: s.title,
        url: s.url,
        domain: s.domain,
        snippet: s.snippet,
        published: s.published,
      });
      onEvent({ type: "citation", citation: task.citations[task.citations.length - 1] });
    }

    task.status = "done";
    onEvent({ type: "done" });
    return task;
  }

  stop() {
    this.browser.close();
  }
}
