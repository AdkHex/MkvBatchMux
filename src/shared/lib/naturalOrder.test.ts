import { describe, expect, it } from "vitest";

import { naturalCompare, naturalSortByPath } from "./naturalOrder";

const names = (items: { path: string }[]) => items.map((item) => item.path.replace(/^.*[\\/]/, ""));

describe("naturalOrder", () => {
  it("puts episode 2 before episode 10, as Explorer does", () => {
    const listed = ["Show - 10.mkv", "Show - 1.mkv", "Show - 2.mkv", "Show - 11.mkv"].map((name) => ({ path: `D:\\Show\\${name}` }));
    expect(names(naturalSortByPath(listed))).toEqual(["Show - 1.mkv", "Show - 2.mkv", "Show - 10.mkv", "Show - 11.mkv"]);
  });

  it("orders unpadded and zero-padded numbering the same way, so two folders pair row for row", () => {
    const videos = naturalSortByPath(["E10", "E2", "E1"].map((e) => ({ path: `D:\\Video\\Show.${e}.mkv` })));
    const dubs = naturalSortByPath(["E02", "E10", "E01"].map((e) => ({ path: `D:\\Dub\\Show.${e}.eac3` })));
    expect(names(videos).map((name) => Number(/E(\d+)/.exec(name)![1]))).toEqual(names(dubs).map((name) => Number(/E(\d+)/.exec(name)![1])));
  });

  it("orders season folders by number in a recursive scan", () => {
    const listed = ["Season 10\\E01.mkv", "Season 2\\E01.mkv", "Season 1\\E02.mkv", "Season 1\\E01.mkv"].map((rest) => ({ path: `D:\\Show\\${rest}` }));
    expect(naturalSortByPath(listed).map((item) => item.path.slice("D:\\Show\\".length))).toEqual(["Season 1\\E01.mkv", "Season 1\\E02.mkv", "Season 2\\E01.mkv", "Season 10\\E01.mkv"]);
  });

  it("ignores case, and keeps the order of names that only differ in case", () => {
    expect(naturalCompare("b.srt", "A.srt")).toBeGreaterThan(0);
    const listed = [{ path: "x\\Ep.MKV", n: 1 }, { path: "x\\ep.mkv", n: 2 }];
    expect(naturalSortByPath(listed).map((item) => item.n)).toEqual([1, 2]);
  });

  it("does not change the list it is given", () => {
    const listed = [{ path: "b" }, { path: "a" }];
    naturalSortByPath(listed);
    expect(listed.map((item) => item.path)).toEqual(["b", "a"]);
  });
});
