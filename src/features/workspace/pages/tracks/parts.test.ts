import { describe, expect, it } from "vitest";

import { nextSlotId } from "./parts";

describe("nextSlotId", () => {
  it("counts on from the highest slot, not the number of slots", () => {
    expect(nextSlotId(["1"])).toBe("2");
    // Audio 2 of 1, 2, 3 deleted: "3" is still taken.
    expect(nextSlotId(["1", "3"])).toBe("4");
    expect(nextSlotId(["3", "1"])).toBe("4");
  });

  it("starts at 1 with no slots", () => {
    expect(nextSlotId([])).toBe("1");
  });
});
