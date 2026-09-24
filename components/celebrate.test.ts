import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has neither a canvas nor media playback; stand in for both and record
// what the celebration asked of them.
const confetti = vi.hoisted(() => Object.assign(vi.fn(), { reset: vi.fn() }));
vi.mock("canvas-confetti", () => ({ default: confetti }));

const played: Array<{ src: string; pause: ReturnType<typeof vi.fn> }> = [];
let playResult: () => Promise<void> = () => Promise.resolve();

class FakeAudio {
  src: string;
  volume = 1;
  pause = vi.fn();
  constructor(src: string) {
    this.src = src;
  }
  play() {
    played.push(this);
    return playResult();
  }
  removeAttribute() {}
  load() {}
}

function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce") }));
}

/** Let the dynamic import and the `play()` promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("celebrate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("Audio", FakeAudio);
    reducedMotion(false);
    played.length = 0;
    playResult = () => Promise.resolve();
    confetti.mockClear();
    confetti.reset.mockClear();
  });

  afterEach(async () => {
    const { stopCelebration } = await import("./celebrate");
    stopCelebration();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays the applause recording and fires fireworks", async () => {
    const { celebrate, APPLAUSE_URL } = await import("./celebrate");
    celebrate({ sound: true });
    await settle();
    vi.advanceTimersByTime(1000);

    expect(played.map((a) => a.src)).toEqual([APPLAUSE_URL]);
    expect(confetti).toHaveBeenCalled();
  });

  it("stays silent when the sound is muted", async () => {
    const { celebrate } = await import("./celebrate");
    celebrate({ sound: false });
    await settle();
    vi.advanceTimersByTime(1000);

    expect(played).toEqual([]);
    expect(confetti).toHaveBeenCalled();
  });

  it("leaves the fireworks out under prefers-reduced-motion", async () => {
    reducedMotion(true);
    const { celebrate } = await import("./celebrate");
    celebrate({ sound: true });
    await settle();
    vi.advanceTimersByTime(1000);

    expect(confetti).not.toHaveBeenCalled();
    expect(played).toHaveLength(1);
  });

  it("swallows a browser refusing to play", async () => {
    playResult = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    const { celebrate } = await import("./celebrate");
    expect(() => celebrate({ sound: true })).not.toThrow();
    await settle(); // an unhandled rejection would fail the run here
  });

  it.each([
    ["a click", () => new PointerEvent("pointerdown", { bubbles: true })],
    ["a key press", () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true })],
  ])("ends on %s anywhere on the page", async (_, event) => {
    const { celebrate } = await import("./celebrate");
    celebrate({ sound: true });
    await settle();

    document.body.dispatchEvent(event());
    expect(played[0].pause).toHaveBeenCalled();
    expect(confetti.reset).toHaveBeenCalled();

    // And stops listening: a later press does nothing more.
    confetti.reset.mockClear();
    document.body.dispatchEvent(event());
    expect(confetti.reset).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare modifier key", { key: "Shift" }],
    ["AltGr", { key: "AltGraph" }],
    ["the repeat of a key held since before the solve", { key: "a", repeat: true }],
  ])("is not ended by %s", async (_, init) => {
    const { celebrate } = await import("./celebrate");
    celebrate({ sound: true });
    await settle();

    document.body.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
    expect(played[0].pause).not.toHaveBeenCalled();
  });

  it("cancels an applause that has not started yet", async () => {
    // A slow connection: the file is still loading when the solver clicks on.
    playResult = () => new Promise(() => {});
    const { celebrate, stopCelebration } = await import("./celebrate");
    celebrate({ sound: true });
    stopCelebration();

    expect(played[0].pause).toHaveBeenCalled();
  });

  it("clears fireworks that were still loading when it was stopped", async () => {
    const { celebrate, stopCelebration } = await import("./celebrate");
    celebrate({ sound: false });
    stopCelebration(); // before the confetti module has arrived
    await settle();
    vi.advanceTimersByTime(1000);

    expect(confetti).not.toHaveBeenCalled();
    expect(confetti.reset).toHaveBeenCalled();
  });

  it("ends the previous celebration when a new one starts", async () => {
    const { celebrate } = await import("./celebrate");
    celebrate({ sound: true });
    await settle();
    celebrate({ sound: true });

    expect(played[0].pause).toHaveBeenCalled();
    expect(played[1].pause).not.toHaveBeenCalled();
  });

  it("listens for nothing when there is nothing to show or play", async () => {
    reducedMotion(true);
    const add = vi.spyOn(document, "addEventListener");
    const { celebrate } = await import("./celebrate");
    celebrate({ sound: false });

    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it("stops the sound and clears the fireworks when stopped", async () => {
    const { celebrate, stopCelebration } = await import("./celebrate");
    celebrate({ sound: true });
    await settle();
    stopCelebration();

    expect(played[0].pause).toHaveBeenCalled();
    expect(confetti.reset).toHaveBeenCalled();
  });
});
