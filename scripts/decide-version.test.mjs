import { describe, expect, it } from "vitest";
import { decideVersion } from "./decide-version.mjs";

describe("decideVersion", () => {
  it("releases an ordinary push as the next minor after the newest tag", () => {
    expect(decideVersion("1.70.0", ["v1.69.0", "v1.70.0"])).toBe("1.71.0");
  });

  it("orders tags as versions, not strings", () => {
    expect(decideVersion("1.9.0", ["v1.9.0", "v1.10.0"])).toBe("1.11.0");
  });

  it("uses a number set by hand when it is newer than every tag", () => {
    expect(decideVersion("2.0.0", ["v1.70.0"])).toBe("2.0.0");
    expect(decideVersion("1.70.1", ["v1.70.0"])).toBe("1.70.1");
  });

  it("ignores tags that are not releases", () => {
    expect(decideVersion("1.70.0", ["v1.70.0", "v2-beta", "latest"])).toBe("1.71.0");
  });

  it("releases the repo's version when nothing is tagged yet", () => {
    expect(decideVersion("1.0.0", [])).toBe("1.0.0");
  });
});
