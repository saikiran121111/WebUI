import { describe, it, expect } from "vitest";
import { hasExplicitBrowserIntent, extractBrowserUrl } from "@/lib/browser/intent";

describe("hasExplicitBrowserIntent (real routing path — no 'may I open the browser?')", () => {
  it("true: strong browser phrasing", () => {
    expect(hasExplicitBrowserIntent("open https://example.com in the browser")).toBe(true);
    expect(hasExplicitBrowserIntent("use the browser to log in to youtube.com")).toBe(true);
    expect(hasExplicitBrowserIntent("navigate to example.com using the built-in browser")).toBe(true);
    expect(hasExplicitBrowserIntent("sign in to github.com for me")).toBe(true);
    expect(hasExplicitBrowserIntent("open a new browser tab on reddit.com")).toBe(true);
  });

  it("true: URL + navigation verb without the word 'browser'", () => {
    expect(hasExplicitBrowserIntent("navigate to example.com")).toBe(true);
    expect(hasExplicitBrowserIntent("go to foo.org")).toBe(true);
    expect(hasExplicitBrowserIntent("load https://openai.com")).toBe(true);
  });

  it("true: browser-mention + interaction verb", () => {
    expect(hasExplicitBrowserIntent("click Save in the web page")).toBe(true);
    expect(hasExplicitBrowserIntent("fill the form on that web page")).toBe(true);
    expect(hasExplicitBrowserIntent("watch the video on this website")).toBe(true);
  });

  it("false: ordinary knowledge/chat questions", () => {
    expect(hasExplicitBrowserIntent("what's the weather in Paris")).toBe(false);
    expect(hasExplicitBrowserIntent("summarize this document")).toBe(false);
    expect(hasExplicitBrowserIntent("compare React and Svelte")).toBe(false);
    expect(hasExplicitBrowserIntent("search for cat memes")).toBe(false);
    expect(hasExplicitBrowserIntent("what does this website look like")).toBe(false);
  });

  it("false: bare domain mention with no verb", () => {
    expect(hasExplicitBrowserIntent("have you heard of example.com?")).toBe(false);
  });
});

describe("extractBrowserUrl — verbatim navigation (youtu.be truncation bug)", () => {
  it("keeps full https urls intact", () => {
    expect(
      extractBrowserUrl("Hey can you open my browser and play this song https://youtu.be/oJMfhZ6QvaY"),
    ).toBe("https://youtu.be/oJMfhZ6QvaY");
    expect(extractBrowserUrl("go to https://example.com/path?x=1&y=2 now")).toBe(
      "https://example.com/path?x=1&y=2",
    );
  });

  it("strips trailing sentence punctuation only", () => {
    expect(extractBrowserUrl("check https://example.com/done.")).toBe("https://example.com/done");
    expect(extractBrowserUrl("open https://en.wikipedia.org/wiki/Cat, please")).toBe(
      "https://en.wikipedia.org/wiki/Cat",
    );
  });

  it("normalizes bare url-shaped tokens that carry a path or www", () => {
    expect(extractBrowserUrl("play youtu.be/oJMfhZ6QvaY in the browser")).toBe(
      "https://youtu.be/oJMfhZ6QvaY",
    );
    expect(extractBrowserUrl("open www.example.com/signup")).toBe("https://www.example.com/signup");
  });

  it("null: prose domains and no url at all", () => {
    expect(extractBrowserUrl("have you heard of example.com?")).toBeNull();
    expect(extractBrowserUrl("open the browser and log in to my bank")).toBeNull();
    expect(extractBrowserUrl("")).toBeNull();
  });
});
