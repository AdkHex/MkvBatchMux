import { describe, expect, it } from "vitest";

import { looksLikeFolder } from "./common";

describe("looksLikeFolder", () => {
  it("reads a release folder's dotted tag as part of its name, not an extension", () => {
    expect(looksLikeFolder("/media/Show.S01.1080p")).toBe(true);
    expect(looksLikeFolder("C:\\media\\Show.S01.2160p\\")).toBe(true);
    expect(looksLikeFolder("/media/Movie.2019")).toBe(true);
    expect(looksLikeFolder("/media/Film.x265")).toBe(true);
    expect(looksLikeFolder("/media/Show.S01")).toBe(true);
  });

  it("still takes a name without an extension as a folder", () => {
    expect(looksLikeFolder("/media/Season 1")).toBe(true);
    expect(looksLikeFolder("/media/Season 1/")).toBe(true);
    expect(looksLikeFolder("/media/Show.S01.1080p.WEB-DL")).toBe(true);
  });

  it("takes real files as files", () => {
    expect(looksLikeFolder("/media/Show.S01E01.1080p.mkv")).toBe(false);
    expect(looksLikeFolder("C:\\media\\Episode 01.MP4")).toBe(false);
    expect(looksLikeFolder("/media/dub.ac3")).toBe(false);
    expect(looksLikeFolder("/media/dub.eac3")).toBe(false);
    expect(looksLikeFolder("/media/raw.264")).toBe(false);
    expect(looksLikeFolder("/media/subs.srt")).toBe(false);
    expect(looksLikeFolder("/media/font.woff2")).toBe(false);
    expect(looksLikeFolder("/media/clip.3gp")).toBe(false);
  });

  it("takes any letters-only extension as a file: an attachment can be anything", () => {
    expect(looksLikeFolder("/media/notes.pdf")).toBe(false);
    expect(looksLikeFolder("/media/fonts.ttc")).toBe(false);
  });
});
