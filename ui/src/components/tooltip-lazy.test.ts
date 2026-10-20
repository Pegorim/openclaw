/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTooltip,
  element,
  dispatchMousePointer,
  hoverTrigger,
  settleTooltip,
  tooltipSurface,
  type TooltipElement,
} from "./tooltip.test-support.ts";

const content = (tooltip: TooltipElement) =>
  tooltipSurface(tooltip)?.querySelector(".tooltip-content");
const description = (trigger: HTMLElement) =>
  document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("materializes content on first hover intent and reuses the native surface", async () => {
  const { tooltip, trigger } = createTooltip("Hover details");
  const untouched = createTooltip("Untouched details");
  document.body.append(tooltip, untouched.tooltip);
  await Promise.all([settleTooltip(tooltip), settleTooltip(untouched.tooltip)]);
  const descriptionId = trigger.getAttribute("aria-describedby")!;
  expect(document.getElementById(descriptionId)?.textContent).toBe("Hover details");
  const popup = tooltipSurface(tooltip)!;
  expect(popup.querySelector(".tooltip-content")).toBeNull();
  hoverTrigger(trigger);
  vi.advanceTimersByTime(149);
  expect(popup.querySelector(".tooltip-content")).toBeNull();
  vi.advanceTimersByTime(1);
  await settleTooltip(tooltip);
  expect(tooltip.hasAttribute("open")).toBe(true);
  expect(popup.matches(":popover-open")).toBe(true);
  expect(popup.querySelector(".tooltip-content")?.textContent).toBe("Hover details");
  expect(content(untouched.tooltip)).toBeNull();
  expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
  dispatchMousePointer(trigger, "pointerleave");
  expect(popup.matches(":popover-open")).toBe(false);
  hoverTrigger(trigger);
  vi.advanceTimersByTime(150);
  await settleTooltip(tooltip);
  expect(tooltipSurface(tooltip)).toBe(popup);
  expect(popup.matches(":popover-open")).toBe(true);
  expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
});

it.each(["cold focus", "focus", "pointer"] as const)("previews on %s intent", async (input) => {
  const tooltip = document.createElement("openclaw-tooltip");
  const anchor = element("button", { textContent: "Preview" });
  document.body.append(anchor, tooltip);
  if (input !== "cold focus") {
    await settleTooltip(tooltip);
    expect(content(tooltip)).toBeNull();
  }
  tooltip.previewForAnchor(anchor, "Preview details", input === "pointer" ? "pointer" : "focus");
  if (input === "cold focus") {
    expect(tooltip.hasAttribute("open")).toBe(false);
  }
  await settleTooltip(tooltip);
  if (input !== "cold focus") {
    vi.advanceTimersByTime(150);
    await settleTooltip(tooltip);
  }
  expect(tooltipSurface(tooltip)?.matches(":popover-open")).toBe(true);
  expect(content(tooltip)?.textContent).toBe("Preview details");
  expect(description(anchor)).toBe("Preview details");
});

it.each(["open", "escape", "disconnect", "toggle", "veto"] as const)(
  "preserves %s intent during first content materialization",
  async (outcome) => {
    const { tooltip, trigger } = createTooltip("Details");
    tooltip.openOnClick = true;
    document.body.append(tooltip);
    await settleTooltip(tooltip);
    if (outcome === "veto") {
      tooltip.addEventListener("overlay-show", (event) => event.preventDefault(), { once: true });
    }
    trigger.click();
    if (outcome === "escape") {
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      trigger.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    } else if (outcome === "disconnect") {
      tooltip.remove();
    } else if (outcome === "toggle") {
      trigger.click();
    }
    await settleTooltip(tooltip);
    expect(tooltip.hasAttribute("open")).toBe(outcome === "open");
    expect(tooltipSurface(tooltip)?.matches(":popover-open") ?? false).toBe(outcome === "open");
  },
);
