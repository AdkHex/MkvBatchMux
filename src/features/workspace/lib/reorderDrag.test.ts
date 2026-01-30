import { describe, expect, it } from "vitest";
import { getAutoScrollDelta, getReorderIndexFromPointer } from "./reorderDrag";

describe("reorderDrag helpers", () => {
  it("computes top insertion index when pointer is above the first row", () => {
    expect(
      getReorderIndexFromPointer({
        containerRect: { top: 100, bottom: 300 },
        scrollTop: 0,
        rowHeight: 48,
        rowCount: 4,
        pointerY: 96,
      }),
    ).toBe(0);
  });

  it("computes a lower index while scrolled", () => {
    expect(
      getReorderIndexFromPointer({
        containerRect: { top: 100, bottom: 300 },
        scrollTop: 96,
        rowHeight: 48,
        rowCount: 5,
        pointerY: 112,
      }),
    ).toBe(2);
  });

  it("returns an upward auto-scroll delta near the top edge", () => {
    expect(
      getAutoScrollDelta({
        containerRect: { top: 100, bottom: 300 },
        pointerY: 104,
      }),
    ).toBeLessThan(0);
  });
});

describe("getAutoScrollDelta", () => {
  const containerRect = { top: 100, bottom: 500 };

  it("never scrolls faster than maxSpeed however far past the edge the pointer goes", () => {
    const farBelow = getAutoScrollDelta({ containerRect, pointerY: 5000, maxSpeed: 18 });
    const farAbove = getAutoScrollDelta({ containerRect, pointerY: -5000, maxSpeed: 18 });

    expect(farBelow).toBeLessThanOrEqual(18);
    expect(farAbove).toBeGreaterThanOrEqual(-18);
  });

  it("does not scroll while the pointer is inside the container", () => {
    expect(getAutoScrollDelta({ containerRect, pointerY: 300 })).toBe(0);
  });
});
