// Mock OpenAI-compatible SSE upstream for scroll verification.
// Streams a long response in many small chunks so the message list grows
// continuously, reproducing real generation pacing.
import http from "node:http";

const CHUNKS = 350;
const DELAY_MS = 8;

const server = http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let i = 0;
    const send = () => {
      if (i >= CHUNKS) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      const content = `word${i.toString(36)} `.repeat(4);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      i++;
      setTimeout(send, DELAY_MS);
    };
    send();
  });
});

server.listen(8081, "127.0.0.1", () => console.log("mock upstream listening on 8081"));
