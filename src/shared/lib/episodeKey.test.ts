import { describe, expect, it } from "vitest";

import { WEAK_KEY, episodeKey, formatEpisodeKey } from "./episodeKey";

/** Season and episode, as one comparable value; confidence is checked apart. */
const se = (path: string) => {
  const key = episodeKey(path);
  return { season: key.season, episode: key.episode, episodeEnd: key.episodeEnd };
};

describe("episodeKey", () => {
  it.each([
    ["Goblin.S01E02.1080p.BluRay.x264-HDEX.mkv", 1, 2],
    ["Show.S01E02.Hindi.DDP5.1.eac3", 1, 2],
    ["show.s1e2.mkv", 1, 2],
    ["Show S2E5.mkv", 2, 5],
    ["Show.S02.E05.720p.mkv", 2, 5],
    ["Show_S03_E10_x265.mkv", 3, 10],
    ["Game.of.Thrones.S08E06.The.Iron.Throne.2160p.UHD.BluRay.x265.10bit.HDR.TrueHD.7.1.Atmos-GROUP.mkv", 8, 6],
    ["Doctor.Who.2005.S01E01.Rose.mkv", 1, 1],
    ["The.Show.S01E24.1080p.WEB.H264-GRP.mkv", 1, 24],
    ["Show - S02E03 - The Title.mkv", 2, 3],
    ["Show Season 1 Episode 2.mkv", 1, 2],
    ["Show.Season.2.Episode.5.mkv", 2, 5],
  ])("reads SxxEyy from %s", (name, season, episode) => {
    expect(se(name)).toEqual({ season, episode, episodeEnd: undefined });
    expect(episodeKey(name).confidence).toBe(1);
  });

  it.each([
    ["Show.1x02.HDTV.mkv", 1, 2],
    ["Show - 01x05 - Title.mkv", 1, 5],
    ["Doctor Who (2005) - 1x01 - Rose.mkv", 1, 1],
    ["Show.10x13.mkv", 10, 13],
  ])("reads NxEE from %s", (name, season, episode) => {
    expect(se(name)).toEqual({ season, episode, episodeEnd: undefined });
    expect(episodeKey(name).confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does not take a resolution or a codec for NxEE", () => {
    expect(episodeKey("Movie.1920x1080.mkv").episode).toBeUndefined();
    expect(episodeKey("Movie.DD5.1x264.mkv").episode).toBeUndefined();
  });

  it.each([
    ["Show.S01E01-E02.mkv", 1, 1, 2],
    ["Show.S01E01E02.mkv", 1, 1, 2],
    ["Show.S01E01-02.720p.mkv", 1, 1, 2],
    ["The.Office.US.S05E14E15.720p.mkv", 5, 14, 15],
    ["Show.S02E03-E04-E05.mkv", 2, 3, 5],
    ["Show.1x01-1x02.mkv", 1, 1, 2],
    ["Show.1x01-02.mkv", 1, 1, 2],
    ["Show EP01-EP02.mkv", undefined, 1, 2],
    ["[Group] Show - 01-02 [1080p].mkv", undefined, 1, 2],
    ["Show 第1-2話.mkv", undefined, 1, 2],
  ])("reads a multi-episode file %s", (name, season, episode, episodeEnd) => {
    expect(se(name)).toEqual({ season, episode, episodeEnd });
  });

  it("does not read a resolution after an episode as the end of a range", () => {
    expect(se("Show.S01E02-1080p.mkv")).toEqual({ season: 1, episode: 2, episodeEnd: undefined });
    expect(se("Show.S01E02-720p.mkv")).toEqual({ season: 1, episode: 2, episodeEnd: undefined });
  });

  it.each([
    ["[SubsPlease] Jujutsu Kaisen - 47 (1080p) [ABCD1234].mkv", undefined, 47],
    ["[Erai-raws] Show 2nd Season - 03 [1080p][Multiple Subtitle].mkv", 2, 3],
    ["[Group] Show - 02v2 [1080p].mkv", undefined, 2],
    ["[Group] Show S2 - 05 [720p].mkv", 2, 5],
    ["Show - 02.en.srt", undefined, 2],
    ["[Group] Show [12][1080p][x265].mkv", undefined, 12],
    ["[Group] Show (03) [BD 1080p].mkv", undefined, 3],
    ["One Piece - 1071 [1080p].mkv", undefined, 1071],
  ])("reads fansub numbering from %s", (name, season, episode) => {
    expect(se(name)).toEqual({ season, episode, episodeEnd: undefined });
    expect(episodeKey(name).confidence).toBeGreaterThanOrEqual(0.75);
  });

  it.each([
    ["Show EP02.mkv", 2],
    ["Show.Ep.03.Hindi.mka", 3],
    ["Show Episode 7.mkv", 7],
    ["Show_E03_Hindi.eac3", 3],
    ["Show #04.mkv", 4],
    ["ショー 第2話.mkv", 2],
    ["ショー 第０２話.mkv", 2],
    ["节目 第02集.mkv", 2],
    ["番組 第3回.mkv", 3],
  ])("reads an episode marker from %s", (name, episode) => {
    expect(episodeKey(name).episode).toBe(episode);
    expect(episodeKey(name).season).toBeUndefined();
    expect(episodeKey(name).confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("reads specials as season 0", () => {
    expect(se("Show.S00E05.Special.mkv")).toEqual({ season: 0, episode: 5, episodeEnd: undefined });
    expect(se("Show - SP01 [1080p].mkv")).toEqual({ season: 0, episode: 1, episodeEnd: undefined });
    expect(se("Show OVA 2.mkv")).toEqual({ season: 0, episode: 2, episodeEnd: undefined });
    expect(se("D:\\Shows\\Show\\Specials\\Show - 01.mkv")).toEqual({ season: 0, episode: 1, episodeEnd: undefined });
    expect(se("/tv/Show/Season 00/Show - 03.mkv")).toEqual({ season: 0, episode: 3, episodeEnd: undefined });
  });

  it("keeps an explicit S01E00 and drops a loose episode 0", () => {
    expect(se("Show.S01E00.Pilot.mkv")).toEqual({ season: 1, episode: 0, episodeEnd: undefined });
    expect(episodeKey("Show - 00 [1080p].mkv").episode).toBeUndefined();
  });

  it("takes the season from the folder when the name has none", () => {
    expect(se("D:\\Shows\\Goblin (2016)\\Season 1\\Goblin - 02.mkv")).toEqual({ season: 1, episode: 2, episodeEnd: undefined });
    expect(se("/media/Show/Season 02/Show EP05.mkv")).toEqual({ season: 2, episode: 5, episodeEnd: undefined });
    expect(se("/media/Show/Staffel 3/Show - 04.mkv")).toEqual({ season: 3, episode: 4, episodeEnd: undefined });
    expect(se("/media/Show.S02.1080p.BluRay/Show - 06.mkv")).toEqual({ season: 2, episode: 6, episodeEnd: undefined });
    // Two folders up: Season 1/Dubs/…
    expect(se("/media/Show/Season 1/Hindi/Show EP03.eac3")).toEqual({ season: 1, episode: 3, episodeEnd: undefined });
  });

  it("lets the name's season win over the folder's", () => {
    expect(se("/media/Show/Season 1/Show.S02E03.mkv")).toEqual({ season: 2, episode: 3, episodeEnd: undefined });
  });

  it("does not take a folder naming one episode for a season pack", () => {
    expect(episodeKey("/media/Show.S01E05.1080p/Show - 05.mkv").season).toBeUndefined();
  });

  it("leaves absolute numbering without a season", () => {
    const key = episodeKey("/anime/Show/Show - 13 [1080p].mkv");
    expect(key.season).toBeUndefined();
    expect(key.episode).toBe(13);
  });

  it.each([
    "Movie.2019.1080p.BluRay.x264-GRP.mkv",
    "Movie (2019) [1080p].mkv",
    "Movie.Name.2160p.UHD.x265.10bit.HDR.mkv",
    "Movie.Name.720p.H.264.AAC2.0.mkv",
    "Movie.Name.DTS-HD.MA.7.1.mkv",
    "Show.Hindi.DDP5.1.Atmos.eac3",
    "Show.Hindi.AAC2.0.mka",
    "Show.Hindi.E-AC-3.mka",
    "Show 10bit x265 HEVC.mkv",
    "Show 6ch 48kHz 640kbps.mka",
    "Show [ABCD1234].mkv",
    "Show - 2019 [1080p].mkv",
    "a.mka",
    "",
  ])("finds no episode in %s", (name) => {
    expect(episodeKey(name)).toEqual({ confidence: 0 });
  });

  it("reads a bare number only weakly, with the pattern around it", () => {
    const key = episodeKey("Goblin 02.mkv");
    expect(key.episode).toBe(2);
    expect(key.confidence).toBeLessThan(WEAK_KEY);
    expect(key.template).toBe("goblin #");
    expect(episodeKey("Track 2.eac3")).toMatchObject({ episode: 2, template: "track #" });
    // The resolution and codec are gone before the number is looked for.
    expect(episodeKey("Show 07 1080p x264.mkv")).toMatchObject({ episode: 7, template: "show #" });
  });

  it("takes an explicit marker over a bare number", () => {
    expect(episodeKey("Show 2 Episode 05.mkv").episode).toBe(5);
    expect(episodeKey("24.S03E04.mkv")).toMatchObject({ season: 3, episode: 4 });
  });
});

describe("formatEpisodeKey", () => {
  it("names the episode the way the files do", () => {
    expect(formatEpisodeKey({ season: 1, episode: 2, confidence: 1 })).toBe("S01E02");
    expect(formatEpisodeKey({ season: 1, episode: 1, episodeEnd: 2, confidence: 1 })).toBe("S01E01–E02");
    expect(formatEpisodeKey({ episode: 13, confidence: 0.8 })).toBe("episode 13");
    expect(formatEpisodeKey({ confidence: 0 })).toBe("no episode");
  });
});
