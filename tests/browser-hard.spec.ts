// Phase-18 HARD journeys (no model): the hard-surface battery against the
// fixture server through the product's real RPC surface — popup adoption,
// file chooser, download-to-disk (bytes verified), JS-dialog mirror,
// iframe/shadow reads, delayed/dynamic/stale DOM, CUA pixel input, dev-log
// mirror, page assets, content export floor, visibility, and the native
// History DB read. Every assertion inspects REAL state (page DOM, bytes on
// disk, server echoes, DB rows) — never model text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { test, expect } from "@playwright/test";
import {
  BrowserE2E,
  assertFixtureServerUp,
  ALERT_MESSAGE,
  DEVLOG_ERROR,
  DEVLOG_INFO,
  DOWNLOAD_CONTENT,
  DOWNLOAD_FILENAME,
  FRAME_MARKER,
  LATE_MARKER,
  POPUP_CHILD_MARKER,
  SHADOW_MARKER,
  UPLOAD_FILENAME,
  UPLOAD_MARKER,
} from "./browser-e2e-helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.beforeAll(async ({ request }) => {
  await assertFixtureServerUp(request);
});

test("hard: popup opened by a turn-owned tab is adopted with an owner", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-hard-popup");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/popup");
    const known = (await e2e.listTabs())
      .map((t) => t.tab_id)
      .filter((x): x is string => typeof x === "string");
    await e2e.click(tab, "#open-popup");
    const popup = await e2e.waitForNewTab(known, "/hard/popup-child");
    const g = await e2e.getTab(popup);
    expect(g.created_by_agent, `adopted popup row: ${JSON.stringify(g)}`).toBe(true);
    expect(String(g.url)).toMatch(/\/hard\/popup-child$/);
    expect(await e2e.innerText(popup, "#popup-marker")).toBe(POPUP_CHILD_MARKER);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: file chooser upload round-trips to the server echo", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-hard-upload");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/upload");
    const uploadPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ruke-e2e-")), UPLOAD_FILENAME);
    fs.writeFileSync(uploadPath, UPLOAD_MARKER);
    // The chooser wait must arm BEFORE the click opens it, so the two calls
    // go out concurrently (mirrors tokio::join! in fixture_journeys).
    const [chooser] = await Promise.all([
      e2e.command("playwright_wait_for_file_chooser", { tab_id: tab, timeout_ms: 15000 }),
      e2e.click(tab, "#file-input"),
    ]);
    expect(typeof chooser.file_chooser_id).toBe("string");
    await e2e.command("playwright_file_chooser_set_files", {
      tab_id: tab,
      files: [uploadPath],
    });
    await e2e.click(tab, "#upload-submit");
    await e2e.command("playwright_wait_for_url", {
      tab_id: tab,
      url: "**/hard/upload-echo",
    });
    const echo = await e2e.innerText(tab, "#upload-echo");
    const lines = echo.split("\n");
    expect(lines, `upload echo: ${JSON.stringify(echo)}`).toContain(`name=${UPLOAD_FILENAME}`);
    expect(lines, `uploaded bytes did not round-trip: ${JSON.stringify(echo)}`).toContain(
      `marker=${UPLOAD_MARKER}`,
    );
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: download lands in the runtime downloads dir with exact bytes", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-hard-download");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/download");
    const [dl] = await Promise.all([
      e2e.command("playwright_wait_for_download", { tab_id: tab, timeout_ms: 20000 }),
      e2e.click(tab, "#dl-link"),
    ]);
    expect(dl.suggested_filename).toBe(DOWNLOAD_FILENAME);
    expect(typeof dl.download_id).toBe("string");
    let diskPath = "";
    for (let i = 0; i < 40 && !diskPath; i++) {
      const r = await e2e.command("playwright_download_path", { tab_id: tab });
      diskPath = String(r.path ?? "");
      if (!diskPath) await sleep(250);
    }
    expect(diskPath, "download never completed into the runtime dir").toBeTruthy();
    // The live server's runtime root is the project root (cwd of the run).
    expect(diskPath.startsWith(path.join(process.cwd(), "downloads"))).toBe(true);
    expect(fs.readFileSync(diskPath).toString("utf8")).toBe(DOWNLOAD_CONTENT);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: JS dialog mirrored, read, accepted; the page records it", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-hard-dialog");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/dialog");
    const none = await e2e.command("tab_get_js_dialog", { tab_id: tab });
    expect(none.dialog).toBeNull();
    await e2e.click(tab, "#show-alert");
    let dialog: Record<string, unknown> | null = null;
    for (let i = 0; i < 30 && !dialog; i++) {
      const r = await e2e.command("tab_get_js_dialog", { tab_id: tab });
      if (r.dialog && typeof r.dialog === "object") dialog = r.dialog as Record<string, unknown>;
      else await sleep(150);
    }
    expect(dialog, "the pump never mirrored the JS dialog").toBeTruthy();
    expect(dialog!.type).toBe("alert");
    expect(dialog!.message).toBe(ALERT_MESSAGE);
    await e2e.command("tab_handle_js_dialog", { tab_id: tab, accept: true });
    let accepted = false;
    for (let i = 0; i < 40 && !accepted; i++) {
      accepted =
        (await e2e.evaluate(tab, "document.getElementById('dlg-state').textContent")) ===
        "dialog-accepted";
      if (!accepted) await sleep(150);
    }
    expect(accepted, "page never recorded the accepted dialog").toBe(true);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: same-origin iframe + open shadow root reads", async ({ request }) => {
  const e2e = new BrowserE2E(request, "e2e-hard-frames");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/iframe");
    await e2e.command("playwright_wait_for_load_state", {
      tab_id: tab,
      state: "networkidle",
    });
    expect(
      await e2e.pwEvaluate(
        tab,
        "document.getElementById('inner-frame').contentDocument.getElementById('frame-marker').textContent",
      ),
    ).toBe(FRAME_MARKER);
    await e2e.navigate(tab, "/hard/shadow");
    expect(
      await e2e.pwEvaluate(
        tab,
        "document.getElementById('the-box').shadowRoot.getElementById('shadow-secret').textContent",
      ),
    ).toBe(SHADOW_MARKER);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: delayed node, dynamic list, stale node swap recovered by selector", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-hard-dom");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/delayed");
    await e2e.command("playwright_locator_wait_for", {
      tab_id: tab,
      selector: "#late",
      state: "visible",
      timeout_ms: 8000,
    });
    expect(await e2e.innerText(tab, "#late")).toBe(LATE_MARKER);

    await e2e.navigate(tab, "/hard/dynamic");
    const before = await e2e.command("playwright_locator_count", {
      tab_id: tab,
      selector: ".item",
    });
    expect(before.count).toBe(0);
    await e2e.click(tab, "#add-item");
    await e2e.click(tab, "#add-item");
    const after = await e2e.command("playwright_locator_count", {
      tab_id: tab,
      selector: ".item",
    });
    expect(after.count).toBe(2);
    const texts = await e2e.command("playwright_locator_all_text_contents", {
      tab_id: tab,
      selector: ".item",
    });
    expect(texts.texts).toEqual(["item-1", "item-2"]);

    await e2e.navigate(tab, "/hard/stale");
    const first = await e2e.innerText(tab, "#stale-node");
    await e2e.command("playwright_wait_for_timeout", { tab_id: tab, timeout_ms: 700 });
    const second = await e2e.innerText(tab, "#stale-node");
    const rev = (s: string) =>
      parseInt(s.trim().replace(/^rev-/, ""), 10);
    expect(rev(second), `stale revs ${first} -> ${second}`).toBeGreaterThan(rev(first));
    const vis = await e2e.command("playwright_locator_is_visible", {
      tab_id: tab,
      selector: "#stale-node",
    });
    expect(vis.visible, "selector did not survive the node swap").toBe(true);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: CUA pixel click + real wheel scroll", async ({ request }) => {
  const e2e = new BrowserE2E(request, "e2e-hard-cua");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/cua");
    await e2e.command("cua_click", { tab_id: tab, x: 180.0, y: 184.0 });
    expect(
      await e2e.evaluate(tab, "document.getElementById('cua-count').textContent"),
    ).toBe("1");

    await e2e.navigate(tab, "/hard/scroll");
    await e2e.command("cua_scroll", {
      tab_id: tab,
      x: 400.0,
      y: 300.0,
      scroll_x: 0.0,
      scroll_y: 600.0,
    });
    await e2e.command("playwright_wait_for_timeout", { tab_id: tab, timeout_ms: 900 });
    const y = Number(await e2e.evaluate(tab, "window.scrollY"));
    expect(y, `real scrollY after wheel: ${y}`).toBeGreaterThanOrEqual(400);
    expect(y).toBeLessThanOrEqual(1200);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: dev-log mirror captures console entries by level", async ({ request }) => {
  const e2e = new BrowserE2E(request, "e2e-hard-devlogs");
  const tab = await e2e.newTab();
  try {
    await e2e.navigate(tab, "/hard/devlogs");
    let infoSeen = false;
    let errorSeen = false;
    for (let i = 0; i < 40 && !(infoSeen && errorSeen); i++) {
      const r = await e2e.command("tab_dev_logs", { tab_id: tab });
      const logs = (r.logs as Array<Record<string, unknown>> | undefined) ?? [];
      for (const entry of logs) {
        const text = String(entry.text ?? "");
        const level = String(entry.level ?? "");
        if (text.includes(DEVLOG_INFO) && level === "info") infoSeen = true;
        if (text.includes(DEVLOG_ERROR) && level === "error") errorSeen = true;
      }
      if (!(infoSeen && errorSeen)) await sleep(200);
    }
    expect(infoSeen, "dev-log mirror never saw the info entry").toBe(true);
    expect(errorSeen, "dev-log mirror never saw the error entry").toBe(true);
  } finally {
    await e2e.closeFixtureTabs();
  }
});

test("hard: page assets, content export floor, visibility, History DB", async ({
  request,
}) => {
  const e2e = new BrowserE2E(request, "e2e-hard-site");
  const tab = await e2e.newTab();
  try {
    // Assets: real Network-observed in-origin asset list + bundle fetch.
    await e2e.navigate(tab, "/hard/assets");
    await e2e.command("playwright_wait_for_load_state", {
      tab_id: tab,
      state: "networkidle",
    });
    const assets = await e2e.command("tab_page_assets_list", { tab_id: tab });
    expect(Number(assets.count)).toBeGreaterThanOrEqual(3);
    const urls = ((assets.assets as Array<Record<string, unknown>>) ?? []).map((a) =>
      String(a.url ?? ""),
    );
    expect(urls.some((u) => u.endsWith("/hard/asset-img.png")), `assets: ${urls}`).toBe(true);
    const bundle = await e2e.command("tab_page_assets_bundle", { tab_id: tab });
    expect(Number(bundle.total_bytes)).toBeGreaterThan(0);

    // Content export: html/text of the REAL page + honest urls floor.
    await e2e.navigate(tab, "/easy");
    const html = await e2e.command("tab_content_export", { tab_id: tab, format: "html" });
    expect(String(html.content)).toContain("go-arrived");
    const text = await e2e.command("tab_content_export", { tab_id: tab, format: "text" });
    expect(String(text.content)).toContain("Arrive at the destination");
    const floor = await e2e.command("tab_content_export", {
      tab_id: tab,
      format: "text",
      urls: ["http://unrelated.invalid/"],
    });
    expect(String(floor.content), "urls floor must yield an honest empty export").toBe("");

    // Visibility: the engine's own host state (headless default in dev).
    const vis = await e2e.command("browser_visibility_get");
    expect(vis.running).toBe(true);
    expect(typeof vis.visible).toBe("boolean");
    expect(typeof vis.note).toBe("string");

    // History: the native Chromium History DB recorded the real visit.
    await e2e.click(tab, "#go-arrived");
    await e2e.command("playwright_wait_for_url", { tab_id: tab, url: "**/easy/arrived" });
    let hit = false;
    for (let i = 0; i < 40 && !hit; i++) {
      const r = await e2e.command("browser_history", {
        queries: ["arrived"],
        limit: 50,
      });
      const entries = (r.entries as Array<Record<string, unknown>> | undefined) ?? [];
      hit = entries.some((e) => String(e.url ?? "").endsWith("/easy/arrived"));
      if (!hit) await sleep(250);
    }
    expect(hit, "History DB never recorded the /easy/arrived visit").toBe(true);
  } finally {
    await e2e.closeFixtureTabs();
  }
});
