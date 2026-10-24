import { describe, it, expect } from "vitest";
import {
  detectSecurityChallenge,
  challengeWaitingReason,
} from "@/lib/browser/securityChallengeDetector";

describe("detectSecurityChallenge — classify BEFORE escalation, never bypass", () => {
  it("captcha: human-verification walls", () => {
    const c = detectSecurityChallenge({
      title: "Captcha gate",
      text: "reCAPTCHA — Human verification required. Please verify you are a human.",
    });
    expect(c!.kind).toBe("captcha");
    expect(c!.guidance).toContain("human-verification");
  });

  it("anti-bot interstitials", () => {
    expect(detectSecurityChallenge({ text: "Checking your browser before accessing…" })!.kind).toBe("anti_bot");
    expect(detectSecurityChallenge({ text: "Just a moment… Pardon our interruption" })!.kind).toBe("anti_bot");
  });

  it("MFA / OTP / passkey prompts", () => {
    const c = detectSecurityChallenge({ text: "Enter the verification code we sent to your device" });
    expect(c!.kind).toBe("mfa");
    expect(c!.guidance).toContain("never share the code");
    expect(detectSecurityChallenge({ text: "Use your passkey to continue" })!.kind).toBe("mfa");
  });

  it("lockout outranks MFA wording in the same page", () => {
    const c = detectSecurityChallenge({
      text: "Your account has been locked. We emailed a verification code.",
    });
    expect(c!.kind).toBe("lockout");
  });

  it("rate limiting via status", () => {
    expect(detectSecurityChallenge({ status: 429, text: "Slow down" })!.kind).toBe("rate_limit");
  });

  it("403 / forbidden pages become access_denied", () => {
    const c = detectSecurityChallenge({ title: "Access restricted", text: "403 Forbidden — Access to this resource is forbidden." });
    expect(c!.kind).toBe("access_denied");
    expect(detectSecurityChallenge({ status: 403, text: "Go away" })!.kind).toBe("access_denied");
  });

  it("login walls only when real (not sign-up fluff)", () => {
    expect(detectSecurityChallenge({ text: "Sign in to continue reading." })!.kind).toBe("login_wall");
    expect(detectSecurityChallenge({ text: "Members-only content. Please log in to access." })!.kind).toBe("login_wall");
  });

  it("ordinary cookie/newsletter banners are NEVER a challenge", () => {
    expect(
      detectSecurityChallenge({
        title: "Shop",
        text: "We use cookies to improve your experience. Accept all cookies. Continue shopping. Subscribe for our newsletter and save 10%",
      }),
    ).toBeNull();
    // A 403 page whose body is really just cookie clutter is not a challenge.
    expect(detectSecurityChallenge({ status: 403, text: "We use cookies. Accept cookies to manage preferences." })).toBeNull();
  });

  it("clean pages return null", () => {
    expect(detectSecurityChallenge({ title: "DOM BASIC", text: "Counter, form, plan picker." })).toBeNull();
  });

  it("waiting reasons map safely (login-ish waits vs user-action waits)", () => {
    expect(challengeWaitingReason("captcha")).toBe("waiting_for_user_action");
    expect(challengeWaitingReason("anti_bot")).toBe("waiting_for_user_action");
    expect(challengeWaitingReason("rate_limit")).toBe("waiting_for_user_action");
    expect(challengeWaitingReason("access_denied")).toBe("waiting_for_user_action");
    expect(challengeWaitingReason("mfa")).toBe("waiting_for_login");
    expect(challengeWaitingReason("login_wall")).toBe("waiting_for_login");
    expect(challengeWaitingReason("lockout")).toBe("waiting_for_login");
  });
});
