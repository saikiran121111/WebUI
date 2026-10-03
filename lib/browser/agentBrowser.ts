import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class BrowserTool {
  private verbose = true;

  async open(url: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(["open", url]);
  }
  async snapshot(): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(["snapshot"]);
  }
  async click(selector: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(["click", selector]);
  }
  async type(selector: string, text: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(["type", selector, text]);
  }
  async scroll(direction: "up" | "down", pixels = 400): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(["scroll", direction, String(pixels)]);
  }
  async read(url?: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(url ? ["read", url] : ["read"]);
  }
  async screenshot(path?: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(path ? ["screenshot", path] : ["screenshot"]);
  }
  async close(): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.run(["close"]);
  }

  private async run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("agent-browser", args, { timeout: 30_000 });
      return { ok: true, stdout: String(stdout), stderr: String(stderr) };
    } catch (e: any) {
      return {
        ok: false,
        stdout: e?.stdout ? String(e.stdout) : "",
        stderr: e?.stderr ? String(e.stderr) : "",
        error: e?.message ?? String(e),
      };
    }
  }
}
