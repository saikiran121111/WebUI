import { describe, expect, it, vi } from "vitest";

/**
 * F21 — render-path ownership. Three defects this pins:
 *  - pdfPageCount() built an unpdf document proxy per export and NEVER
 *    destroyed it (a parsed copy of every generated PDF leaked per turn).
 *  - renderPdf()/renderChartPng() created the page and installed the egress
 *    guard OUTSIDE their try, so a guard/setup throw returned with an open page.
 *  - the shared browser was a bare promise, so nothing owned its teardown.
 * No Chromium here: the page and the PDF library are stubs, so the assertions
 * are about ownership, not rendering.
 */

const { fake } = vi.hoisted(() => {
  const fake = {
    pagesClosed: 0,
    pagesCreated: 0,
    routeShouldThrow: false,
    proxiesDestroyed: 0,
    proxyThrowsOnRead: false,
    browserLeases: 0,
  };
  return { fake };
});

vi.mock("@/lib/documents/browser", () => ({
  withRenderBrowser: async (fn: (browser: unknown) => Promise<unknown>) => {
    fake.browserLeases++;
    const browser = {
      newPage: async () => {
        fake.pagesCreated++;
        const page = {
          closed: false,
          route: async () => {
            if (fake.routeShouldThrow) throw new Error("route setup refused");
          },
          evaluate: async () => undefined,
          waitForTimeout: async () => undefined,
          setContent: async () => undefined,
          goto: async () => undefined,
          $: async () => null,
          boundingBox: async () => null,
          screenshot: async () => Buffer.from("png"),
          pdf: async () => Buffer.from("%PDF-1.4 stub"),
          close: async () => {
            if (!page.closed) {
              page.closed = true;
              fake.pagesClosed++;
            }
          },
        };
        return page;
      },
    };
    return fn(browser);
  },
}));

vi.mock("unpdf", () => ({
  getDocumentProxy: async () => ({
    numPages: fake.proxyThrowsOnRead
      ? {
          valueOf() {
            throw new Error("proxy read failed");
          },
        }
      : 3,
    destroy: async () => {
      fake.proxiesDestroyed++;
    },
  }),
}));

import { pdfPageCount, renderChartPng, renderPdf } from "@/lib/documents/pdfEngine";

describe("pdfPageCount - owns the document proxy it created (F21)", () => {
  it("destroys the proxy after reading the page count", async () => {
    fake.proxiesDestroyed = 0;
    expect(await pdfPageCount(Buffer.from("%PDF-1.4 stub"))).toBe(3);
    expect(fake.proxiesDestroyed).toBe(1);
  });

  it("destroys the proxy even when reading the count throws", async () => {
    fake.proxiesDestroyed = 0;
    fake.proxyThrowsOnRead = true;
    await expect(pdfPageCount(Buffer.from("%PDF-1.4 stub"))).rejects.toBeTruthy();
    expect(fake.proxiesDestroyed).toBe(1);
    fake.proxyThrowsOnRead = false;
  });
});

describe("renderPdf - closes the page on EVERY outcome (F21)", () => {
  it("happy path closes exactly once and reports the page count", async () => {
    fake.pagesCreated = 0;
    fake.pagesClosed = 0;
    fake.routeShouldThrow = false;
    fake.proxiesDestroyed = 0;
    const res = await renderPdf("<h1>hello</h1>", "note");
    expect(res.filename).toBe("note.pdf");
    expect(res.pageCount).toBe(3);
    expect(res.blockedRequests).toBe(0);
    expect(fake.pagesCreated).toBe(1);
    expect(fake.pagesClosed).toBe(1);
    expect(fake.proxiesDestroyed).toBe(1);
  });

  it("a guard that throws still closes the page it made", async () => {
    fake.pagesCreated = 0;
    fake.pagesClosed = 0;
    fake.routeShouldThrow = true;
    await expect(renderPdf("<h1>hello</h1>")).rejects.toThrow("route setup refused");
    expect(fake.pagesCreated).toBe(1);
    expect(fake.pagesClosed).toBe(1);
    fake.routeShouldThrow = false;
  });

  it("the browser lease is held for the whole render and released on failure", async () => {
    const before = fake.browserLeases;
    await expect(renderPdf("<h1>x</h1>")).resolves.toBeTruthy();
    expect(fake.browserLeases).toBe(before + 1);
  });
});

describe("renderChartPng - closes the page and removes its temp file (F21)", () => {
  it("a guard failure closes the page and deletes the temp html", async () => {
    fake.pagesCreated = 0;
    fake.pagesClosed = 0;
    fake.routeShouldThrow = true;
    await expect(
      renderChartPng("<svg/>", { width: 10, height: 10 }),
    ).rejects.toThrow("route setup refused");
    expect(fake.pagesCreated).toBe(1);
    expect(fake.pagesClosed).toBe(1);
    fake.routeShouldThrow = false;
  });
});
