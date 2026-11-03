// PHASE 6 — task-scope browser E2E matrix (docs/task-scope-audit.md test plan;
// handover §7). Arbitrary FIXTURE site names (Zeeta Mart / Loqal Coffee /
// Quipqort Emporium — zero production knowledge), explicit-URL "mocked"
// discovery (the target arrives fully resolved in the user's own words, so
// discovery adds nothing to race against), and multiple local origins
// (http://127.0.0.1:3210 vs http://localhost:3210 — same fixture server,
// DISTINCT affinity hosts: a PSL/IP literal vs the "localhost" label, exactly
// the discriminator the engine keys on).
//
// Every assertion reads REAL engine/page state over the RPC + panel DOM —
// landed/attempted URLs, blocked actions, displayed selection — NEVER model
// prose and NEVER command echoes. Model-driven journeys pin the exact steps
// (browser-model-acceptance style); the omnibox journey needs no model.
//
// Rows covered HERE: panel-open-vs-closed routing; destination denial
// (affinity card, Decline); authorized multisite hop (Accept, one-shot,
// proven INDEPENDENT of saved facet policy — localhost access is pre-armed
// "never_ask" yet the affinity card still parks); displayed working tab +
// unrelated background tab; follow-up target change (turn 2 re-folds scope,
// turn 1's tab untouched); in-origin redirect (assert the LANDED url);
// omnibox address-vs-search + history Back.
//
// Rows covered deterministically elsewhere (verified mapping, do not re-run
// here): capitalization / multiword / uncommon-TLD / explicit-URL /
// ambiguous / incidental / negations / preference-vs-restriction /
// target-change merge → task-scope corpus 56/56 BOTH languages
// (rust-backend/fixtures/task-scope/cases.json); gate failure / zero results
// / bot blocks / wall classification → ruke-websearch tools classification
// tests + web-search-10k suite; form fills / popups / iframe / dialogs /
// uploads → tests/browser-easy|medium|hard.spec.ts +
// ruke-browser/tests/fixture_journeys.rs; CDP-evaluate/WebMCP escape +
// destination pre-gates + affinity one-shot semantics → ruke-browser unit +
// integration batteries (177); fallback provenance tagging →
// ruke-websearch slug_triangulation tests ⇔ TS mirrors; working-tab
// follow/pin law + omnibox PSL law → __tests__/browser-store.test.ts +
// __tests__/browser-client.test.ts pins.
//
// PATIENCE RULE (docs/e2e-test-state.md): one attempt per locked -Grep
// invocation, retries off; per-test timeout exceeds the assertion window
// plus model overflow. Deliverable-marking: model-created tabs must call
// tab_mark_deliverable to survive turn cleanup — the prompts say so, exactly
// like the HARD acceptance journey.
//
// Run via scripts/run-browser-e2e-exclusive.ps1 (starts fixture :3210 + dev
// supervisor). One journey per invocation via -Grep; J7 (omnibox) touches no
// model at all and may run with its siblings.

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  BrowserE2E, assertFixtureServerUp,
  FIXTURE_BASE, EASY_ARRIVED,
  SCOPE_ZEETA, SCOPE_ZEETA_CHECKOUT, SCOPE_LOQAL, SCOPE_QUIPQORT,
} from "./browser-e2e-helpers";

const BASE = "http://localhost:3000";
// Fresh chat at "/" ⇒ activeId null ⇒ panel session + browser_session marker
// are both "default" (app/page.tsx law), same as browser-model-acceptance.
const SESSION = "default";
// The second local origin: same fixture server, DIFFERENT affinity host.
// Affinity scope keys the literal IP (PSL reduces 127.0.0.1 to itself);
// "localhost" is a separate registrable name ⇒ an off-scope hop by law.
const OTHER_ORIGIN = "http://localhost:3210";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

async function tabUrl(e2e: BrowserE2E, tabId: string): Promise<string> {
  const t = (await e2e.listTabs()).find((row) => row.tab_id === tabId);
  return t?.url ?? "";
}

async function tabBySuffix(e2e: BrowserE2E, suffix: string) {
  return (await e2e.listTabs()).find((t) => (t.url ?? "").endsWith(suffix));
}

/** Sweep ALL journey debris before a journey starts and after it ends.
 *  The engine launches Chromium on a PERSISTENT profile (host.rs
 *  `--user-data-dir`), and session-restored tabs from earlier runs attach
 *  as USER tabs (engine.rs startup-tab law) — including deliverable-marked
 *  model tabs from previous journeys. Those pollute the panel (a restored
 *  tab can hold the panel selection and steal an omnibox navigation), so
 *  every journey owns a clean tab set. Swept: both fixture origin
 *  spellings (closeFixtureTabs only knows the FIXTURE_BASE literal) and
 *  blank/error leftovers (Chromium's initial page, chrome-error:// from
 *  prior failures). One spare blank tab is left alive when it's the last
 *  tab standing — closing Chromium's final tab can kill the window the
 *  CDP connection rides on. */
async function sweepTabs(e2e: BrowserE2E): Promise<void> {
  const tabs = await e2e.listTabs().catch(() => []);
  const junk = tabs.filter((t) => {
    if (typeof t.tab_id !== "string") return false;
    const url = t.url ?? "";
    return (
      url.startsWith(FIXTURE_BASE) ||
      url.startsWith(OTHER_ORIGIN) ||
      url === "" ||
      url === "about:blank" ||
      url.startsWith("chrome://") ||
      url.startsWith("chrome-error://")
    );
  });
  if (junk.length === tabs.length && tabs.length > 0) {
    // Keep one tab alive (prefer a blank one) so the browser never dies
    // mid-suite; it is re-swept next round once other tabs exist.
    const spare = junk.find((t) => !(t.url ?? "").startsWith("http"));
    if (spare) {
      await Promise.all(
        junk.filter((t) => t.tab_id !== spare.tab_id).map((t) => e2e.command("tab_close", { tab_id: t.tab_id }).catch(() => {})),
      );
      return;
    }
  }
  for (const t of junk) {
    await e2e.command("tab_close", { tab_id: t.tab_id }).catch(() => {});
  }
}

/** Saved-permission pre-arming for BOTH origins. Pre-arming localhost's
 *  access facet while the scope is 127.0.0.1-only is deliberate: the
 *  task_scope affinity card must STILL park (saved permissions and task
 *  affinity are separate checks — audit #7/#8 law). */
async function armPolicy(request: APIRequestContext): Promise<void> {
  for (const host of ["127.0.0.1", "localhost"]) {
    const res = await request.put("/api/browser/policy", {
      data: { host, facet: "access", decision: "never_ask" },
    });
    expect(res.ok(), `policy PUT access@${host} failed: HTTP ${res.status()}`).toBe(true);
  }
}

/** Arm policy, optionally open the panel through its real TopBar toggle. */
async function arm(page: Page, request: APIRequestContext, openPanel = true): Promise<BrowserE2E> {
  await armPolicy(request);
  await page.goto(BASE + "/");
  await assertFixtureServerUp(request);
  if (openPanel) {
    const panel = page.getByRole("complementary", { name: "Browser panel" });
    if (!(await panel.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Open browser panel" }).click();
    }
    await expect(panel).toBeVisible({ timeout: 10_000 });
  }
  const e2e = new BrowserE2E(request, SESSION);
  // Journey start = clean slate: session-restored tabs from earlier runs
  // (persistent profile) must not hold the panel selection or count as
  // journey state (e.g. a stale deliverable-marked localhost tab would
  // false-fail the DENIAL row's "nothing landed off-scope" assertion).
  await sweepTabs(e2e);
  return e2e;
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Message Ruke");
  await box.fill(text);
  await box.press("Enter");
  await expect(
    page.getByText(text.slice(0, 20)).first(),
    "composer send never reached the transcript",
  ).toBeVisible({ timeout: 15_000 });
}

/** Wait for the model stream (Stop button) to end, then let turn cleanup
 *  settle before post-turn state assertions. */
async function waitTurnEnd(page: Page): Promise<void> {
  await expect(page.getByLabel("Stop generating"), "model stream never finished")
    .toHaveCount(0, { timeout: 420_000 });
  await sleep(1500);
}

async function runTurn(page: Page, text: string): Promise<void> {
  await sendPrompt(page, text);
  await waitTurnEnd(page);
}

/** Await the parked task_scope card for the off-scope hop, verify it names
 *  the exact destination, and answer it as the human. The card is the ONLY
 *  blocker here (both facets are pre-armed), so its appearance proves the
 *  affinity pre-gate fired BEFORE the page loaded. */
async function answerScopeCard(page: Page, button: "Accept" | "Decline"): Promise<void> {
  const group = page.getByRole("group", { name: "Browser permission requests" });
  await until(() => group.isVisible().catch(() => false), 300_000, `task_scope card for ${OTHER_ORIGIN}`);
  await expect(
    group.getByText(`${OTHER_ORIGIN}/scope/loqal`).first(),
    `parked card does not name the exact off-scope destination: ${await group.innerText()}`,
  ).toBeVisible();
  await group.getByRole("button", { name: button }).click();
}

  // pw-57 lesson (turn-cleanup law, session.rs end_turn): per turn ONLY two
  // tabs are protected from cleanup — ONE deliverable + ONE handoff, each
  // slot latest-call-wins. "Mark EVERY tab" instructions silently overwrite
  // the slot and get the earlier tab reaped (the product is correct; the
  // prompt must respect the two-slot law). Tabs from EARLIER turns are
  // already protected by their own turn's marks — re-marking them in a later
  // turn steals that turn's slot from a tab that actually needs it.
  const MARK_KEEP =
    ` If this turn created new tabs, protect at most two of them from turn cleanup: ` +
    `call "tab_mark_deliverable" on the most important one and, if you created a second, "tab_mark_handoff" on it — ` +
    `call each of those tools at most once THIS turn, and NEVER mark a tab that an earlier turn opened ` +
    `(earlier-turn tabs already survive on their own turn's marks). `;

test.describe("task-scope browser E2E matrix (Phase 6, one journey per locked invocation)", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  test.setTimeout(480_000);
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.afterEach(async ({ request }) => {
    // Sweep journey debris (both origin spellings + blank/error restored
    // tabs — see sweepTabs for the persistent-profile session-restore law).
    await sweepTabs(new BrowserE2E(request, SESSION));
  });

  test("ROUTING: panel CLOSED — operate intent + session marker still route to the browser turn", async ({ page, request }) => {
    // The panel-open-vs-closed law (Phase 3): panel visibility is NEVER an
    // input. With the panel closed the model must still reach the engine.
    const e2e = await arm(page, request, false);
    await expect(page.getByRole("complementary", { name: "Browser panel" })).toHaveCount(0);

    await runTurn(
      page,
      `Use the browser tools. Open a NEW tab at ${FIXTURE_BASE}/scope/quipqort, then read the page and tell me ` +
        `the exact text inside the element with CSS selector "#scope-marker".` + MARK_KEEP,
    );

    const tab = await until(async () => Boolean(await tabBySuffix(e2e, "/scope/quipqort")), 60_000, "tab landed on /scope/quipqort");
    const landed = await tabBySuffix(e2e, "/scope/quipqort");
    expect(await e2e.innerText(landed!.tab_id as string, "#scope-marker")).toBe(SCOPE_QUIPQORT);
    void tab;
  });

  // pw-52 lesson (scope-folding semantics): foldTaskScope folds EVERY URL
  // the USER names into the turn's targets, so a prompt naming both hosts
  // makes the hop IN SCOPE and no card can park — the premise was never
  // manufactured. The off-scope destination must therefore come from PAGE
  // content (untrusted data never widens scope — the model cannot broaden
  // the contract through tool arguments): the fixture's #partner-site link
  // carries the localhost address, and the prompt only instructs following
  // it. The model reaches it through navigate/tab-new (destinations known
  // in advance per executor.rs `known_destination`), so the task_scope
  // card must park BEFORE the page loads. A click-initiated hop is NOT
  // destination-pre-gated by design (documented engine limitation) — hence
  // the explicit "navigation command, not a click" instruction.
  const HOP_PROMPT =
    `Use the browser tools. Open a NEW tab at ${FIXTURE_BASE}/scope/zeeta and read it. ` +
    `The page has a link with CSS selector "#partner-site" pointing to a partner site; make the browser visit ` +
    `the exact address written in that link's href attribute — use the browser navigation/address tool with that ` +
    `address (do NOT click the link). Then read the "#scope-marker" element on the partner page. ` +
    `Finally, protect your tabs from turn cleanup with the two-slot law: "tab_mark_deliverable" on exactly one tab ` +
    `you opened this turn and, if you opened a second tab this turn, "tab_mark_handoff" on it (call each at most once). ` +
    `If a tool call is refused, stop that step and say so — do NOT retry it or use another address.`;

  test("DENIAL: off-scope hop (localhost vs 127.0.0.1) parks a task_scope card BEFORE load; Decline blocks it", async ({ page, request }) => {
    const e2e = await arm(page, request);

    await sendPrompt(page, HOP_PROMPT);
    await answerScopeCard(page, "Decline");
    await waitTurnEnd(page);

    // Blocked ACTION state, not prose: nothing ever landed on the second
    // origin, and the in-scope tab is untouched.
    const offenders = (await e2e.listTabs()).filter((t) => (t.url ?? "").startsWith(OTHER_ORIGIN));
    expect(offenders, `off-scope navigation was NOT blocked: ${JSON.stringify(offenders)}`).toEqual([]);
    const zeeta = await tabBySuffix(e2e, "/scope/zeeta");
    expect(zeeta?.tab_id, "in-scope zeeta tab missing").toBeTruthy();
    expect(await tabUrl(e2e, zeeta!.tab_id as string)).toBe(`${FIXTURE_BASE}/scope/zeeta`);
  });

  test("HOP: explicit human Accept authorizes ONE off-scope hop; marker lands; card was the only blocker", async ({ page, request }) => {
    const e2e = await arm(page, request);

    await sendPrompt(page, HOP_PROMPT);
    // localhost access is pre-armed never_ask — the destination passes the
    // saved-permission gate and is still held by the task_scope card alone
    // (separate checks law), so Accept here authorizes exactly this hop.
    await answerScopeCard(page, "Accept");
    await waitTurnEnd(page);

    const loqal = (await e2e.listTabs()).find((t) => (t.url ?? "").startsWith(`${OTHER_ORIGIN}/scope/loqal`));
    expect(loqal?.tab_id, "authorized hop never landed on the second origin").toBeTruthy();
    expect(await e2e.innerText(loqal!.tab_id as string, "#scope-marker")).toBe(SCOPE_LOQAL);
    expect(await e2e.innerText((await tabBySuffix(e2e, "/scope/zeeta"))!.tab_id as string, "#scope-marker")).toBe(SCOPE_ZEETA);
  });

  test("WORKING TAB: panel selection follows the engine's working tab; unrelated background tab untouched", async ({ page, request }) => {
    const e2e = await arm(page, request);
    // Human-owned background tab (turn "ui" identity — survives turn cleanup):
    // the engine must never steer or disturb it.
    // pw-55 lesson: /easy is the journey LANDING page — the EASY_ARRIVED
    // marker lives only on /easy/arrived (its link target). The background
    // tab sits on that terminal page, where an exact marker probe works.
    const bg = await e2e.newTab();
    await e2e.navigate(bg, "/easy/arrived");
    expect(await e2e.innerText(bg, "#arrived-marker")).toBe(EASY_ARRIVED);

    await runTurn(
      page,
      `Use the browser tools. Do NOT touch any already-open tab. Step 1: open a NEW tab at ${FIXTURE_BASE}/scope/zeeta. ` +
        `Step 2: on that NEW tab ONLY, click the link with CSS selector "#to-checkout" (it stays on the same tab). ` +
        `Step 3: read the "#scope-marker" element on that tab. Step 4: call tab_mark_deliverable on that tab.` + MARK_KEEP,
    );

    // Landed URL after the in-page click:
    const work = await tabBySuffix(e2e, "/scope/zeeta/checkout");
    expect(work?.tab_id, "working tab never reached checkout").toBeTruthy();
    expect(await e2e.innerText(work!.tab_id as string, "#scope-marker")).toBe(SCOPE_ZEETA_CHECKOUT);
    // Background tab state: same URL AND same live marker — the engine
    // never steered or re-rendered it off its arrived page.
    expect(await tabUrl(e2e, bg), "background tab was moved").toBe(`${FIXTURE_BASE}/easy/arrived`);
    expect(await e2e.innerText(bg, "#arrived-marker"), "background tab content was disturbed").toBe(EASY_ARRIVED);
    // Displayed working tab: the panel's selected tab follows the engine
    // (browser:working_tab frames; no human pin in this journey).
    const selected = page.getByRole("tab", { selected: true });
    await expect(selected, "panel shows exactly one selected tab").toHaveCount(1);
    await expect(selected, "panel selection did not follow the engine's working tab")
      .toContainText(/checkout/i);
  });

  test("FOLLOW-UP: turn 2 retargets scope to a new explicit URL; turn 1's tab stays put", async ({ page, request }) => {
    const e2e = await arm(page, request);

    await runTurn(
      page,
      `Use the browser tools. Open a NEW tab at ${FIXTURE_BASE}/scope/zeeta, read its "#scope-marker", then call ` +
        `tab_mark_deliverable on that tab.` + MARK_KEEP,
    );
    const zeeta = await tabBySuffix(e2e, "/scope/zeeta");
    expect(zeeta?.tab_id, "turn 1 never landed on zeeta").toBeTruthy();

    await runTurn(
      page,
      `Now use the browser tools on a DIFFERENT target: open a NEW tab at ${FIXTURE_BASE}/scope/quipqort, read its ` +
        `"#scope-marker", then call tab_mark_deliverable on that new tab.` + MARK_KEEP,
    );

    const quip = await tabBySuffix(e2e, "/scope/quipqort");
    expect(quip?.tab_id, "turn 2 never landed on the new target").toBeTruthy();
    expect(await e2e.innerText(quip!.tab_id as string, "#scope-marker")).toBe(SCOPE_QUIPQORT);
    expect(await tabUrl(e2e, zeeta!.tab_id as string), "turn 1 target tab was disturbed by the retarget")
      .toBe(`${FIXTURE_BASE}/scope/zeeta`);
  });

  test("REDIRECT: in-scope 302 lands on the TARGET url (assert landed, not requested)", async ({ page, request }) => {
    const e2e = await arm(page, request);
    const tab = await e2e.newTab();
    await e2e.navigate(tab, "/easy");

    await runTurn(
      page,
      `Use the browser tools on the already-open tab at ${FIXTURE_BASE}/easy (do not open new tabs): navigate that tab ` +
        `to ${FIXTURE_BASE}/scope/redirect, then read the "#scope-marker" element and tell me the marker text.` + MARK_KEEP,
    );

    const landed = await tabUrl(e2e, tab);
    expect(landed, "redirect landed somewhere unexpected").toBe(`${FIXTURE_BASE}/scope/zeeta`);
    expect(await e2e.innerText(tab, "#scope-marker")).toBe(SCOPE_ZEETA);
  });

  test("OMNIBOX (no model): address law navigates, search phrase hands off to the composer, Back restores history", async ({ page, request }) => {
    const e2e = await arm(page, request);
    const tab = await e2e.newTab();
    await e2e.navigate(tab, "/easy");

    // The RPC does NOT move the panel selection — tab_new/tab navigation on
    // the "ui" identity leave the selected tab whatever it already was
    // (possibly a session-restored tab). Pin OUR tab in the panel first:
    // click it by its real page title, exactly what the human does.
    await page.getByRole("tab", { name: /Fixture Easy/ }).first().click();
    await expect(
      page.getByRole("tab", { selected: true }),
      "panel selection did not follow the tab we clicked",
    ).toContainText(/Fixture Easy/i);

    // Hand-off capture, installed BEFORE the first Enter so the address
    // step is ALSO asserted (a URL must never leak into the composer).
    // Event-level capture localizes any hand-off break: (a) no event ⇒
    // panel submitOmnibox dispatch is broken; (b) event + empty composer ⇒
    // ChatInput consumer is broken. A self-dispatched LIVENESS PROBE on
    // the same channel proves the capture listener is alive before the
    // panel's silence can be blamed on the panel. page.on("pageerror")
    // traps silent throws in the panel's keydown path (a thrown handler
    // would look identical to "not dispatched" otherwise).
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}`));
    const PROBE = "__omni_liveness_probe__";
    await page.evaluate((probe) => {
      const w = window as unknown as { __omniHandoff?: { text?: string }[] };
      w.__omniHandoff = [];
      document.addEventListener(
        "ruke:open-annotation",
        (ev) => w.__omniHandoff!.push(((ev as CustomEvent).detail ?? {}) as { text?: string }),
      );
      document.dispatchEvent(
        new CustomEvent("ruke:open-annotation", { detail: { text: probe } }),
      );
    }, PROBE);
    const handoffs = async () =>
      (
        await page.evaluate(
          () => (window as unknown as { __omniHandoff?: { text?: string }[] }).__omniHandoff ?? [],
        )
      ).filter((d) => d.text !== PROBE);
    // Liveness: the probe itself must have been captured (and ChatInput's
    // real consumer prepends it — clear the composer again afterwards).
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              () => (window as unknown as { __omniHandoff?: { text?: string }[] }).__omniHandoff ?? [],
            )
          ).some((d) => d.text === PROBE),
        { message: "hand-off capture listener never saw its own probe event" },
      )
      .toBe(true);
    await page.getByLabel("Message Ruke").fill("");

    // Address law: `127.0.0.1:3210/...` (IP literal + port) is an address ⇒
    // the selected tab navigates, and the scheme fix (Phase-6 catch:
    // unschemed IP/port ⇒ http://, never https:// — plain-HTTP origins die
    // on SSL otherwise) must carry it. Landed URL asserted over the RPC,
    // not DOM.
    const bar = page.getByLabel("Address bar");
    await bar.fill(`127.0.0.1:3210/scope/loqal`);
    await bar.press("Enter");
    await until(async () => (await tabUrl(e2e, tab)).endsWith("/scope/loqal"), 20_000, "omnibox address navigation");
    expect(await e2e.innerText(tab, "#scope-marker")).toBe(SCOPE_LOQAL);
    expect(
      await handoffs(),
      `address submission leaked a composer hand-off (page errors: ${JSON.stringify(pageErrors)})`,
    ).toEqual([]);

    // Search law: a bare query phrase is NOT an address ⇒ no navigation;
    // the text hands off to the composer exactly once (RUKE web-search
    // gate; the human sends).
    const PHRASE = "quibble zork mctest phrase";
    await bar.fill(PHRASE);
    await bar.press("Enter");
    await sleep(1500);
    expect(await tabUrl(e2e, tab), "a search phrase was treated as an address").toBe(`${FIXTURE_BASE}/scope/loqal`);
    const evidence = await page.evaluate(() => ({
      bar: (document.querySelector('[aria-label="Address bar"]') as HTMLInputElement | null)?.value ?? null,
    }));
    const evs = await handoffs();
    expect(
      evs,
      `panel dispatched no composer hand-off for a search phrase (address bar then held: ` +
        `${JSON.stringify(evidence.bar)}; page errors: ${JSON.stringify(pageErrors)})`,
    ).toHaveLength(1);
    expect(
      (evs[0] as { text?: string }).text,
      "hand-off detail carries the wrong text",
    ).toContain(PHRASE);
    expect(pageErrors, "uncaught page errors during the omnibox journey").toEqual([]);
    await expect(page.getByLabel("Message Ruke")).toHaveValue(new RegExp(PHRASE));

    // History: Back on the panel restores the previous in-tab entry (human
    // turn identity — the honest source-tab post-landing path). Scoped to
    // the panel + exact name: the app TopBar also exposes a "Go back"
    // button whose label substring-matches a bare getByLabel("Back").
    await page
      .getByRole("complementary", { name: "Browser panel" })
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await until(async () => (await tabUrl(e2e, tab)).endsWith("/easy"), 20_000, "history Back navigation");

    // Leave the composer unsent (zero model traffic in this journey).
  });
});
