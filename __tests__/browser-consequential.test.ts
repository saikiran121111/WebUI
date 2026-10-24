import { describe, it, expect } from "vitest";
import { isConsequentialName } from "@/lib/browser/browserActions";

/**
 * Pins the server-side consequential gate's vocabulary in both directions.
 * Real consent enforcement (grant/park/skip-if-done) lives in taskState and
 * is exercised E2E by tests/browser-fallback.spec.ts ("Confirm transfer");
 * this file guards the heuristic itself against drift.
 */
describe("consequential-action heuristic", () => {
  it("gates money, content-out, deletion, transfer, final submit, legal binding", () => {
    for (const name of [
      "Pay now", "Payment", "Buy now", "Checkout", "Place order",
      "Send message", "Post comment", "Publish",
      "Delete account", "Remove item",
      "Confirm transfer", "Submit application", "Apply now",
      "Sign contract", "Sign agreement", "Accept terms",
    ]) {
      expect(isConsequentialName(name), name).toBe(true);
    }
  });

  it("ordinary navigation, pagination, search, sign-in and cookie wording sail through", () => {
    for (const name of [
      "Load more", "Next page", "Continue", "Search site", "Run query",
      "Accept all cookies", "Sign in", "Save name", "Increment counter",
      "I passed the check", "Done completing the code",
    ]) {
      expect(isConsequentialName(name), name).toBe(false);
    }
  });

  it("documented conservatism: a button literally named “Send <word>” gates", () => {
    // Intentional false-positive class — the safe side of the heuristic.
    // This is why the dom-poor fixture's search button says "Run query".
    expect(isConsequentialName("Send query")).toBe(true);
    expect(isConsequentialName("Send")).toBe(true);
  });
});
