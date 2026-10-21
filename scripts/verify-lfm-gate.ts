import { runLfmGate } from "../src/lib/web-search/lfm-gate";

async function main() {
  const t0 = Date.now();

  const r1 = await runLfmGate({ userPrompt: "Hey there how are you" });
  console.log(
    "greeting:",
    JSON.stringify({ sr: r1.decision.search_required, source: r1.source, lfmMs: r1.lfmMs }),
  );

  const r2 = await runLfmGate({
    userPrompt: "Tell me what is the best restaurant in manikonda hyderabad I want to eat biryani",
  });
  console.log(
    "biryani: ",
    JSON.stringify({
      sr: r2.decision.search_required,
      source: r2.source,
      lfmMs: r2.lfmMs,
      queries: r2.decision.queries.map((q) => q.query.slice(0, 60)),
    }),
  );

  console.log("total ms:", Date.now() - t0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
