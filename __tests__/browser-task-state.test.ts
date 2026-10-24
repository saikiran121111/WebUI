import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startTask,
  currentTask,
  updateTask,
  logStep,
  markNonIdempotentDone,
  hasDoneNonIdempotent,
  clearTask,
  grantConsequentialAuthorization,
  hasConsequentialGrant,
  consumeConsequentialGrant,
  revokeConsequentialGrant,
  requestConfirmation,
  sameFlowPage,
  taskFlowMismatch,
  isStaleTask,
  TASK_TTL_MS,
  type BrowserTask,
} from "@/lib/browser/taskState";

describe("browser task state — persistence, resume safety, server-side grants", () => {
  beforeEach(() => clearTask());
  afterEach(() => {
    revokeConsequentialGrant();
    clearTask();
  });

  it("startTask creates a task with a unique id and running state", () => {
    const t = startTask("watch the product demo", "chrome");
    expect(t.id).toMatch(/^t[0-9a-z]+$/);
    expect(t.objective).toBe("watch the product demo");
    expect(t.state).toBe("running");
    expect(currentTask()!.id).toBe(t.id);
  });

  it("updateTask patches state and reason", () => {
    startTask("obj");
    updateTask({ state: "waiting_for_login", reason: "private_account_access_consent", url: "https://x.test" });
    const t = currentTask()!;
    expect(t.state).toBe("waiting_for_login");
    expect(t.reason).toBe("private_account_access_consent");
    expect(t.url).toBe("https://x.test");
  });

  it("logStep records ok/failed steps", () => {
    startTask("obj");
    logStep("navigate", true);
    logStep("click", false);
    const t = currentTask()!;
    expect(t.steps.length).toBe(2);
    expect(t.steps[1]).toMatchObject({ action: "click", ok: false });
  });

  it("non-idempotent signatures are remembered (deduped) for safe resume", () => {
    startTask("obj");
    markNonIdempotentDone("click:https://x.test:Confirm transfer");
    markNonIdempotentDone("click:https://x.test:Confirm transfer");
    const t = currentTask()!;
    expect(t.completedNonIdempotent.length).toBe(1);
    expect(hasDoneNonIdempotent("click:https://x.test:Confirm transfer")).toBe(true);
    expect(hasDoneNonIdempotent("click:https://x.test:Cancel")).toBe(false);
  });

  it("grants are single-use and expire on new confirmation requests", () => {
    startTask("obj");
    expect(hasConsequentialGrant()).toBe(false);
    expect(consumeConsequentialGrant()).toBe(false);

    grantConsequentialAuthorization();
    expect(hasConsequentialGrant()).toBe(true);
    expect(consumeConsequentialGrant()).toBe(true);
    expect(consumeConsequentialGrant()).toBe(false); // single-use

    grantConsequentialAuthorization();
    requestConfirmation("consequential_action_consent"); // a new pending ask revokes
    expect(hasConsequentialGrant()).toBe(false);

    grantConsequentialAuthorization();
    revokeConsequentialGrant();
    expect(hasConsequentialGrant()).toBe(false);
  });

  it("requestConfirmation parks the task in waiting_for_confirmation", () => {
    startTask("obj");
    requestConfirmation("private_account_access_consent");
    expect(currentTask()!.state).toBe("waiting_for_confirmation");
  });

  it("clearTask wipes everything", () => {
    startTask("obj");
    markNonIdempotentDone("s");
    clearTask();
    expect(currentTask()).toBeNull();
  });
});

describe("task staleness — an old flow (or a test run) must never hijack a live session", () => {
  beforeEach(() => clearTask());
  afterEach(() => {
    vi.useRealTimers();
    clearTask();
  });

  it("an expired task is invisible AND its skip-if-done sigs stop applying", () => {
    startTask("fixture flow");
    markNonIdempotentDone("click:http://localhost:3000/fixtures/x:Run query");
    expect(hasDoneNonIdempotent("click:http://localhost:3000/fixtures/x:Run query")).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + TASK_TTL_MS + 60_000));
    expect(currentTask()).toBeNull();
    expect(hasDoneNonIdempotent("click:http://localhost:3000/fixtures/x:Run query")).toBe(false);
    vi.useRealTimers();

    // A fresh flow starts clean afterwards.
    expect(startTask("play a song").objective).toBe("play a song");
  });

  it("a task inside the TTL survives unchanged", () => {
    startTask("obj");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60 * 60_000)); // 1 h < 2 h TTL
    expect(currentTask()?.objective).toBe("obj");
    vi.useRealTimers();
  });

  it("sameFlowPage ignores query/hash but not path", () => {
    expect(
      sameFlowPage("https://x.test/a/b?si=1#frag", "https://x.test/a/b"),
    ).toBe(true);
    expect(sameFlowPage("https://x.test/a", "https://x.test/b")).toBe(false);
    expect(sameFlowPage("https://x.test/a", "http://localhost:3000/fixtures/e.html")).toBe(false);
    expect(sameFlowPage(undefined, "https://x.test")).toBe(false);
  });

  it("taskFlowMismatch: live about:blank vs a fixture park is a mismatch; a closed browser is not", () => {
    const t: BrowserTask = {
      id: "t1",
      objective: "fixture flow",
      state: "waiting_for_user_action",
      steps: [],
      completedNonIdempotent: [],
      url: "http://localhost:3000/fixtures/browser-fallback/exhausted.html",
      updatedAt: Date.now(),
    };
    // The exact live shape of the bug report: parked at the fixture, live tab blank.
    expect(taskFlowMismatch(t, "about:blank")).toBe(true);
    expect(taskFlowMismatch(t, "https://youtu.be/oJMfhZ6QvaY")).toBe(true);
    // No live tab AND no new target url → legitimate park stays.
    expect(taskFlowMismatch(t, undefined)).toBe(false);
    // Browser idle-closed but the user names the SAME page → still no mismatch.
    expect(
      taskFlowMismatch(t, undefined, "http://localhost:3000/fixtures/browser-fallback/exhausted.html"),
    ).toBe(false);
    // …a DIFFERENT new target → mismatch.
    expect(taskFlowMismatch(t, undefined, "https://youtu.be/oJMfhZ6QvaY")).toBe(true);
  });

  it("isStaleTask only strips the resume directive when the park contradicts the live page", () => {
    const t: BrowserTask = {
      id: "t1",
      objective: "o",
      state: "waiting_for_confirmation",
      steps: [],
      completedNonIdempotent: [],
      url: "https://bank.test/confirm",
      updatedAt: Date.now(),
    };
    expect(isStaleTask(t, undefined)).toBe(false); // closed browser: keep the directive
    expect(isStaleTask(t, "https://bank.test/confirm?step=2")).toBe(false); // same page
    expect(isStaleTask(t, "https://other.test/x")).toBe(true); // different live page
    const running: BrowserTask = { ...t, state: "running" };
    expect(isStaleTask(running, "https://other.test/x")).toBe(false); // not a park
  });
});
