/**
 * PART 4 genre gate — every content genre the WebUI research pipeline must
 * handle end-to-end, run through the pipeline DIRECTLY (no browser UI, no
 * model call — the evidence bundle is the artifact under test).
 *
 * Usage:  npx tsx scripts/verify-all-genres.ts [--only <substring>]
 *   --only matches case-insensitively against each check's id group
 *   (e.g. "--only youtube" runs just the YouTube checks).
 *
 * Checks: the exact PART 4 prompts — Irumudi/IMDb, both youtu.be links,
 * the LinkedIn profile query, the maps.app.goo.gl unwrap — plus the
 * genre grid (Blinkit/Myntra/Zepto/BookMyShow/Zomato/.gov.in/Wikipedia/
 * Reddit/Workday). Pass = non-empty evidence + genre-specific facts reach
 * the bundle (login-walled sites count via searchResults baselines or the
 * auth_required stage, per the SERP-baseline invariant).
 */
import { mkdirSync, writeFileSync } from "fs";
import {
  runWebResearch,
  evidenceBlock,
  closeCache,
} from "../lib/web-search/index";
import type { EvidenceBundle, PipelineProgress } from "../lib/web-search/pipeline";

const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface GenreCheck {
  id: string;
  prompt: string;
  /** Extra pass conditions on the bundle + evidence text (lowercased). */
  assert: (bundle: EvidenceBundle, evidence: string) => [boolean, string];
}

const domainsIn = (b: EvidenceBundle) =>
  [...b.searchResults.map((r) => r.domain), ...b.packets.map((p) => p.domain)]
    .join(" ").toLowerCase();

function hasUrlLike(bundle: EvidenceBundle, sub: string): boolean {
  const hay = [...bundle.searchResults.map((r) => r.url), ...bundle.packets.map((p) => p.url)]
    .join(" ").toLowerCase();
  return hay.includes(sub.toLowerCase());
}

const CHECKS: GenreCheck[] = [
  {
    id: "imdb:irumudi",
    prompt: "Do you know about movie irumudi and tell me its imdb rating",
    assert: (b, ev) => {
      const imdbHit =
        domainsIn(b).includes("imdb") || /imdb|im db|rating/i.test(ev);
      const titleHit = /irumudi|irumadi|irulumadi|irulimudi|irumbudi/i.test(ev);
      const rating = /\b\d(?:\.\d)?\s*\/\s*10\b|[Rr]ating[^.]{0,40}\b\d\.\d/.test(ev);
      return [
        imdbHit && titleHit && rating,
        `imdb=${imdbHit} title=${titleHit} rating=${rating} ev=${ev.length}b`,
      ];
    },
  },
  {
    id: "youtube:wwMFNoEeth8",
    prompt: "https://youtu.be/wwMFNoEeth8 watch this video and tell me the game name",
    assert: (b, ev) => {
      const yt = domainsIn(b).includes("youtu");
      return [
        yt && ev.length > 300,
        `youtubePackets=${yt} evidence=${ev.length}b`,
      ];
    },
  },
  {
    id: "youtube:zinbNw7L8xI",
    prompt: "https://youtu.be/zinbNw7L8xI",
    assert: (b, ev) => {
      const yt = domainsIn(b).includes("youtu");
      return [yt && ev.length > 300, `youtubePackets=${yt} evidence=${ev.length}b`];
    },
  },
  {
    id: "linkedin:profile",
    prompt: "can you find this profile name phani venkata sai kiran in linkedIN",
    assert: (b) => {
      // Query fix must produce site:linkedin.com/in results; even when the
      // profile itself walls extraction (999), the SERP baseline invariant
      // keeps LinkedIn URLs/snippets in the bundle and auth_required may fire.
      const inUrls = hasUrlLike(b, "linkedin.com/in");
      const anyLi = domainsIn(b).includes("linkedin");
      const walled = b.authRequired.length > 0;
      return [inUrls || walled || (anyLi && b.searchResults.length > 0), `inUrls=${inUrls} linkedin=${anyLi} authWalls=${walled} results=${b.searchResults.length}`];
    },
  },
  {
    id: "maps:goo-gl-unwrap",
    prompt: "https://maps.app.goo.gl/pDMFFw4XaSzNJhgW6 can you tell me which location it is",
    assert: (b, ev) => {
      // Unwrapped URLs look like google.com/maps/place/… — the domain is
      // google.com, so match the URL path shape, not "maps.google" only.
      const maps =
        hasUrlLike(b, "goo.gl") ||
        hasUrlLike(b, "/maps") ||
        domainsIn(b).includes("maps") ||
        domainsIn(b).includes("google");
      const place = /location|place|address|lat|coordinates|map/i.test(ev);
      return [maps && place && ev.length > 200, `maps=${maps} placeTalk=${place} ev=${ev.length}b`];
    },
  },
  {
    id: "commerce:blinkit",
    prompt: "What is Blinkit's delivery time promise and what is it known for?",
    assert: (_b, ev) => {
      const hit = /blinkit/i.test(ev) && /\b\d{1,2}\s*(min|minutes)|quick commerce|grocery/i.test(ev);
      return [hit, `facts=${hit} ev=${ev.length}b`];
    },
  },
  {
    id: "commerce:myntra",
    prompt: "What does Myntra sell and who owns it?",
    assert: (_b, ev) => {
      const hit = /myntra/i.test(ev) && /(fashion|apparel|clothing|lifestyle)/i.test(ev);
      return [hit, `facts=${hit} ev=${ev.length}b`];
    },
  },
  {
    id: "commerce:zepto",
    prompt: "What is Zepto and how fast does it deliver?",
    assert: (_b, ev) => {
      const hit = /zepto/i.test(ev) && /(grocery|quick commerce|\d{1,2}\s*(min|minutes))/i.test(ev);
      return [hit, `facts=${hit} ev=${ev.length}b`];
    },
  },
  {
    id: "tickets:bookmyshow",
    prompt: "What is BookMyShow and what can you book on it?",
    assert: (_b, ev) => {
      const hit = /bookmyshow/i.test(ev) && /(movie|ticket|cinema|event)/i.test(ev);
      return [hit, `facts=${hit} ev=${ev.length}b`];
    },
  },
  {
    id: "food:zomato",
    prompt: "What is Zomato and which company owns its Indian operations now?",
    assert: (_b, ev) => {
      const hit = /zomato/i.test(ev) && /(food|restaurant|deliver|swiggy|eternal)/i.test(ev);
      return [hit, `facts=${hit} ev=${ev.length}b`];
    },
  },
  {
    id: "gov:gov-in",
    prompt: "What is the official digital India portal on the gov.in domain?",
    assert: (b) => {
      const hit = hasUrlLike(b, ".gov.in") || domainsIn(b).includes(".gov.in");
      return [hit, `govInUrls=${hit} results=${b.searchResults.length}`];
    },
  },
  {
    id: "wiki:wikipedia",
    prompt: "According to Wikipedia, what is the capital of Australia?",
    assert: (b, ev) => {
      const hit = domainsIn(b).includes("wikipedia") && /canberra/i.test(ev);
      return [hit, `wikiDomain=${domainsIn(b).includes("wikipedia")} canberra=${/canberra/i.test(ev)}`];
    },
  },
  {
    id: "social:reddit",
    prompt: "What do people on Reddit say is the best budget e-reader?",
    assert: (b, ev) => {
      const hit = domainsIn(b).includes("reddit") && ev.length > 300;
      return [hit, `reddit=${domainsIn(b).includes("reddit")} ev=${ev.length}b`];
    },
  },
  {
    id: "authwall:workday",
    prompt: "What is Workday and how do candidates apply for jobs on Workday career pages?",
    assert: (b, ev) => {
      const hit = /workday/i.test(ev) && (domainsIn(b).includes("workday") || b.searchResults.length > 3);
      return [hit, `workday=${/workday/i.test(ev)} results=${b.searchResults.length}`];
    },
  },
];

const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? (process.argv[onlyIdx + 1] ?? "").toLowerCase() : "";
const tokens = only.split("|").map((s) => s.trim()).filter(Boolean);
const selected = tokens.length
  ? CHECKS.filter((c) => tokens.some((t) => c.id.includes(t) || c.prompt.toLowerCase().includes(t)))
  : CHECKS;

let passCount = 0;
let failCount = 0;
const authRequiredSeen: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passCount++; console.log(GREEN("  ✓ ") + label + (detail ? `  ${YELLOW(detail)}` : "")); }
  else { failCount++; console.log(RED("  ✗ ") + label + (detail ? `  ${RED(detail)}` : "")); }
}

async function main() {
  console.log(BOLD(`\n── PART 4 all-genres gate (${selected.length} checks) ──\n`));
  for (const c of selected) {
    console.log(BOLD(`${c.id} — "${c.prompt}"`));
    const t0 = performance.now();
    let bundle: EvidenceBundle | null = null;
    const progress: PipelineProgress[] = [];
    try {
      bundle = await runWebResearch(
        { userPrompt: c.prompt, history: [] },
        (p) => {
          progress.push(p);
          if (p.stage === "auth_required") {
            authRequiredSeen.push(`${c.id}: ${p.url ?? p.domain ?? ""}`);
            console.log(YELLOW(`   [auth_required] ${p.url ?? p.domain ?? ""}`));
          }
        },
      );
    } catch (e) {
      check(c.id, false, `pipeline threw: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const ms = Math.round(performance.now() - t0);
    if (!bundle) { check(c.id, false, `runWebResearch returned null (gate skipped?) ${ms}ms`); continue; }
    const evidence = evidenceBlock(bundle);
    const [ok, detail] = c.assert(bundle, evidence);
    check(c.id, ok, `${detail} ${ms}ms packets=${bundle.packets.length} results=${bundle.searchResults.length}`);
    if (!ok) {
      // Post-mortem dump for a failing genre (git-ignored .data/).
      try {
        mkdirSync(".data/tmp-genre", { recursive: true });
        writeFileSync(
          `.data/tmp-genre/${c.id.replace(/[<>:"/\\|?*]/g, "_")}.txt`,
          `PROMPT: ${c.prompt}\nDETAIL: ${detail}\nDOMAINS/URLS:\n${domainsIn(bundle)}\n\nEVIDENCE:\n${evidence}`,
        );
      } catch { /* best effort */ }
    }
  }

  console.log(BOLD("\n── Summary ──"));
  if (authRequiredSeen.length) {
    console.log(YELLOW(`auth_required stage fired ${authRequiredSeen.length}×:`));
    for (const a of authRequiredSeen) console.log(`   ${a}`);
  } else {
    console.log("auth_required stage did not fire (login-wall sites may have resolved via pool/baselines).");
  }
  console.log(`${GREEN(`${passCount} passed`)}, ${failCount ? RED(`${failCount} failed`) : "0 failed"}`);
  closeCache();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => { console.error(RED(`fatal: ${e instanceof Error ? e.stack ?? e.message : e}`)); closeCache(); process.exit(2); });
