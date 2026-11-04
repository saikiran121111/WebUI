/**
 * Browser store follow/pin law (task-scope audit #10).
 *
 * Pins the `browser:working_tab` contract end-to-end on the client:
 * 1. frames are SESSION + TURN + TAB qualified — a cross-session or
 *    stale-turn frame is refused, never allowed to steer the panel;
 * 2. an explicit human tab click is a MANUAL PIN that outranks the
 *    engine's follow until the session/turn boundary clears it;
 * 3. `setTabs` follows the engine's working tab when the fresh listing
 *    contains it (absent a pin), and falls back to the classic
 *    still-alive / first-tab law otherwise;
 * 4. `browser:preparing` is the turn boundary (resets follow state and
 *    lifts the pin); mid-turn `browser:acting` never resets it — only
 *    a session swap does.
 *
 * These are pure-store tests: no fetch, no sockets. The store is a
 * module singleton, so every test resets it first.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getBrowserState,
  handleBrowserStage,
  resetBrowserStoreForTests,
  selectTab,
  setTabs,
} from "../lib/browser-client/browserStore";
import type { BrowserTab } from "../lib/browser-client/browserClient";

const tab = (tab_id: string): BrowserTab => ({
  tab_id,
  url: `https://${tab_id}.test/`,
  title: tab_id,
  created_by_agent: true,
});

beforeEach(() => {
  resetBrowserStoreForTests();
});

describe("browser:working_tab frames", () => {
  it("follows the engine's working tab while the human has not pinned", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    const s = getBrowserState();
    expect(s.workingTab).toBe("tabB");
    expect(s.workingTurn).toBe("t1");
    expect(s.selected).toBe("tabB"); // follow
    expect(s.manualPin).toBe(false);
  });

  it("refuses a frame from a DIFFERENT session", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s2", "tabX", "t1");
    const s = getBrowserState();
    expect(s.workingTab).toBeNull();
    expect(s.conversation).toBe("s1"); // untouched by the refused frame
    expect(s.selected).toBeNull();
  });

  it("refuses a frame from a stale (different) turn", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabA", "t1");
    // A delayed SSE frame from an older turn can never steer this turn.
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t0");
    const s = getBrowserState();
    expect(s.workingTab).toBe("tabA");
    expect(s.selected).toBe("tabA");
  });

  it("a frame with no turn attribute still lands while keeping the turn stamp", () => {
    // The Rust emitter always stamps turn; frames that omit it (TS-only
    // paths) update the tab without claiming a different turn.
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabA", "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabB");
    const s = getBrowserState();
    expect(s.workingTab).toBe("tabB");
    expect(s.workingTurn).toBe("t1");
  });

  it("the first frame claims an unknown session (nothing to refuse yet)", () => {
    handleBrowserStage("browser:working_tab", "s9", "tabZ", "t1");
    const s = getBrowserState();
    expect(s.conversation).toBe("s9");
    expect(s.workingTab).toBe("tabZ");
  });

  it("manual pin outranks the follow, but tracking still updates", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    setTabs([tab("tabA"), tab("tabB")]);
    selectTab("tabA"); // the human clicked — pin
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    const s = getBrowserState();
    expect(s.workingTab).toBe("tabB"); // tracked for later
    expect(s.selected).toBe("tabA"); // the click survives
    expect(s.manualPin).toBe(true);
  });

  it("preparing is the turn boundary: it clears follow state and lifts the pin", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    selectTab("tabA");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    handleBrowserStage("browser:preparing", "s1", undefined, "t2");
    let s = getBrowserState();
    expect(s.workingTab).toBeNull();
    expect(s.workingTurn).toBeNull();
    expect(s.manualPin).toBe(false);
    // With the pin lifted, the follow works again on the new turn.
    handleBrowserStage("browser:working_tab", "s1", "tabC", "t2");
    s = getBrowserState();
    expect(s.selected).toBe("tabC");
  });

  it("a session swap mid-turn resets follow state even on an acting frame", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    selectTab("tabA");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    handleBrowserStage("browser:acting", "s2"); // different conversation
    const s = getBrowserState();
    expect(s.conversation).toBe("s2");
    expect(s.workingTab).toBeNull();
    expect(s.workingTurn).toBeNull();
    expect(s.manualPin).toBe(false);
  });

  it("same-session acting frames never reset follow state", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    handleBrowserStage("browser:acting", "s1");
    const s = getBrowserState();
    expect(s.workingTab).toBe("tabB");
    expect(s.workingTurn).toBe("t1");
    expect(s.selected).toBe("tabB");
  });
});

describe("setTabs selection law", () => {
  it("follows the working tab when the listing contains it", () => {
    setTabs([tab("tabA"), tab("tabB")]);
    expect(getBrowserState().selected).toBe("tabA"); // first tab, no engine yet
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    expect(getBrowserState().selected).toBe("tabB"); // frame follow
    // A refresh listing keeps the follow, not the old selection.
    setTabs([tab("tabB"), tab("tabA")]);
    expect(getBrowserState().selected).toBe("tabB");
  });

  it("a pinned selection survives setTabs and a working-tab frame", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    setTabs([tab("tabA"), tab("tabB")]);
    selectTab("tabA");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    setTabs([tab("tabA"), tab("tabB")]);
    expect(getBrowserState().selected).toBe("tabA"); // pin beats follow
  });

  it("falls back to the classic law when the working tab left the listing", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1"); // selection followed to tabB
    setTabs([tab("tabA")]); // tabB closed
    const s = getBrowserState();
    expect(s.selected).toBe("tabA"); // still-alive law: no tabB → first tab
    expect(s.workingTab).toBe("tabB"); // stale stamp kept; refused by setTabs logic
  });
});

describe("selectTab pins unconditionally", () => {
  it("a click sets manualPin true", () => {
    handleBrowserStage("browser:preparing", "s1", undefined, "t1");
    setTabs([tab("tabA"), tab("tabB")]);
    handleBrowserStage("browser:working_tab", "s1", "tabB", "t1");
    selectTab("tabA");
    const s = getBrowserState();
    expect(s.selected).toBe("tabA");
    expect(s.manualPin).toBe(true);
  });
});
