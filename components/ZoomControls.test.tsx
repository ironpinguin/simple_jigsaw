import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import { MAX_SCALE, MIN_SCALE } from "@/lib/puzzle/zoom";
import ZoomControls from "./ZoomControls";
import { createViewStore, type ViewStore } from "./viewStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const handlers = () => ({
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onReset: vi.fn(),
});

/** Zoom the board without panning it — the store carries the whole transform. */
const setScale = (store: ViewStore, scale: number) => store.set({ ...store.get(), scale });

function mount(store: ViewStore, on = handlers()) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ZoomControls store={store} {...on} />
      </NextIntlClientProvider>,
    );
  });
  return on;
}

/** The buttons are identified the way a screen reader would find them. */
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

const readout = () => container.querySelector("output")!;
const isDisabled = (label: string) => button(label).getAttribute("aria-disabled") === "true";

describe("the zoom readout", () => {
  it("shows the store's scale as a percentage", () => {
    mount(createViewStore());
    expect(readout().textContent).toBe("100%");
  });

  it("follows the stage when the scale changes outside React", () => {
    const store = createViewStore();
    mount(store);
    act(() => setScale(store, 1.5));
    expect(readout().textContent).toBe("150%");
    act(() => setScale(store, 1));
    expect(readout().textContent).toBe("100%");
  });

  it("is not a live region, so a wheel gesture is not announced tick by tick", () => {
    mount(createViewStore());
    expect(readout().getAttribute("aria-live")).toBe("off");
  });
});

describe("the zoom buttons", () => {
  it("report the press to the board", () => {
    const on = mount(createViewStore());
    button("Zoom in").click();
    button("Zoom out").click();
    button("Reset view").click();
    expect(on.onZoomIn).toHaveBeenCalledOnce();
    expect(on.onZoomOut).toHaveBeenCalledOnce();
    expect(on.onReset).toHaveBeenCalledOnce();
  });

  it("are both available between the limits", () => {
    mount(createViewStore());
    expect(isDisabled("Zoom in")).toBe(false);
    expect(isDisabled("Zoom out")).toBe(false);
  });

  it("marks zoom in unavailable at the top limit, leaving zoom out usable", () => {
    const store = createViewStore();
    const on = mount(store);
    act(() => setScale(store, MAX_SCALE));
    expect(isDisabled("Zoom in")).toBe(true);
    expect(isDisabled("Zoom out")).toBe(false);
    button("Zoom in").click();
    expect(on.onZoomIn).not.toHaveBeenCalled();
    button("Zoom out").click();
    expect(on.onZoomOut).toHaveBeenCalledOnce();
  });

  it("marks zoom out unavailable at the bottom limit, leaving zoom in usable", () => {
    const store = createViewStore();
    const on = mount(store);
    act(() => setScale(store, MIN_SCALE));
    expect(isDisabled("Zoom out")).toBe(true);
    expect(isDisabled("Zoom in")).toBe(false);
    button("Zoom out").click();
    expect(on.onZoomOut).not.toHaveBeenCalled();
  });

  it("stays focusable at a limit, so keyboard focus is not dropped", () => {
    // `disabled` would move focus to <body> on the very press that reaches the
    // limit; `aria-disabled` keeps the control where the user left it.
    const store = createViewStore();
    mount(store);
    button("Zoom in").focus();
    act(() => setScale(store, MAX_SCALE));
    expect(button("Zoom in").hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button("Zoom in"));
  });

  it("becomes available again once the scale comes back off the limit", () => {
    const store = createViewStore();
    const on = mount(store);
    act(() => setScale(store, MAX_SCALE));
    act(() => setScale(store, 1));
    expect(isDisabled("Zoom in")).toBe(false);
    button("Zoom in").click();
    expect(on.onZoomIn).toHaveBeenCalledOnce();
  });
});
