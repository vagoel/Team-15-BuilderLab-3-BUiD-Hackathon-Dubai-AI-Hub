import { describe, expect, it, vi } from "vitest";
import { shouldAdoptSession } from "./useVoiceSession.js";

/**
 * `useVoiceSession` itself needs a DOM (React rendering, `document`,
 * `requestAnimationFrame`, `navigator.mediaDevices`) that this repo's test
 * environment does not provide — there is no jsdom/testing-library installed, and
 * adding one is out of scope here. The two lifecycle bugs fixed in that hook are
 * instead pulled out as small pure functions so the actual decision logic can be
 * exercised directly, without a DOM or a mocked Conversation SDK.
 */

describe("shouldAdoptSession", () => {
  it("adopts a session that connected while nothing else happened", () => {
    expect(shouldAdoptSession(true, 3, 3)).toBe(true);
  });

  it("refuses to adopt once the epoch moved on — the stop-mid-connect bug", () => {
    // This is the exact shape of the bug: start() captures epoch 1, the user presses
    // Stop before it resolves (which bumps the epoch), and the connection finishes
    // moments later. Before this fix nothing distinguished that from an ordinary
    // successful connect, so the UI flipped back to "connected" as if Stop had never
    // been pressed, leaking a live mic session the user believed they had ended.
    expect(shouldAdoptSession(true, 1, 2)).toBe(false);
  });

  it("refuses to adopt after unmount even if the epoch did not move", () => {
    expect(shouldAdoptSession(false, 1, 1)).toBe(false);
  });
});

