import { NextRequest, NextResponse } from "next/server";

const LLM_API_URL =
  process.env.LLM_API_URL || "http://127.0.0.1:8081/v1/chat/completions";
const LLM_API_KEY = process.env.LLM_API_KEY || "no-key";

function stripThinkFromText(raw: string): string {
  if (!raw) return raw;

  let out = raw;
  out = out.replace(/<think>[\s\S]*?<\/think>/g, "");
  out = out.replace(/^[\s\S]*?<\/think>/g, "");
  out = out.replace(/<think>[\s\S]*$/g, "");
  return out;
}

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
      return NextResponse.json(
        { error: "No response body from upstream" },
        { status: 502 }
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = "";
    let inThinkBlock = false;

    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstreamRes.body!.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            for (const event of events) {
              const lines = event.split("\n");
              const outputLines: string[] = [];

              for (const line of lines) {
                if (!line.startsWith("data: ")) {
                  outputLines.push(line);
                  continue;
                }

                const payload = line.slice(6).trim();

                if (payload === "[DONE]") {
                  outputLines.push("data: [DONE]");
                  continue;
                }

                try {
                  const json = JSON.parse(payload);
                  const delta = json?.choices?.[0]?.delta;

                  if (delta?.content && typeof delta.content === "string") {
                    let text = delta.content;

                    if (inThinkBlock) {
                      const endIdx = text.indexOf("</think>");
                      if (endIdx === -1) {
                        delta.content = "";
                      } else {
                        text = text.slice(endIdx + "</think>".length);
                        inThinkBlock = false;
                        delta.content = stripThinkFromText(text);
                      }
                    } else {
                      const startIdx = text.indexOf("<think>");
                      if (startIdx !== -1) {
                        const before = text.slice(0, startIdx);
                        const afterStart = text.slice(startIdx + "<think>".length);
                        const endIdx = afterStart.indexOf("</think>");

                        if (endIdx === -1) {
                          inThinkBlock = true;
                          delta.content = before;
                        } else {
                          const after = afterStart.slice(endIdx + "</think>".length);
                          delta.content = before + stripThinkFromText(after);
                        }
                      } else {
                        delta.content = stripThinkFromText(text);
                      }
                    }
                  }

                  if (delta?.reasoning_content && typeof delta.reasoning_content === "string") {
                    delta.reasoning_content = stripThinkFromText(delta.reasoning_content);
                  }

                  outputLines.push(`data: ${JSON.stringify(json)}`);
                } catch {
                  outputLines.push(line);
                }
              }

              controller.enqueue(encoder.encode(outputLines.join("\n") + "\n\n"));
            }
          }

          if (buffer.trim()) {
            controller.enqueue(encoder.encode(buffer));
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type":
          upstreamRes.headers.get("Content-Type") || "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Proxy error:", message);
    return NextResponse.json(
      {
        error:
          "Could not connect to the model server. Make sure llama.cpp is running on port 8080.",
      },
      { status: 503 }
    );
  }
}