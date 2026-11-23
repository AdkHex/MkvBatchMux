/** Which episode a file is, read from its name and the folders it sits in.
 *
 *  Dubs, subtitles and chapters are paired with videos by this key rather than
 *  by row when the names allow it, so a missing dub leaves a gap instead of
 *  shifting every later dub onto the wrong episode. A wrong key is worse than
 *  none (it pairs the wrong episode with confidence), so each pattern carries
 *  how sure it is, and numbers that are something else -- a resolution, a
 *  codec, a year, a channel layout -- are taken out before any bare number is
 *  read. */

export interface EpisodeKey {
  /** From the name ("S02E05", "2x05", "2nd Season") or a parent folder
   *  ("Season 2", "Specials" is 0). Absent for absolute numbering. */
  season?: number;
  episode?: number;
  /** The last episode of a multi-episode file ("S01E01-E02"). */
  episodeEnd?: number;
  /** 0 when nothing was found. 1 for an explicit SxxEyy; under 0.5 for a bare
   *  number, which pairing only trusts when the files around it share its
   *  pattern (see `template`). */
  confidence: number;
  /** For a bare number only: the name with that number replaced by "#", so a
   *  run of "Goblin 01", "Goblin 02"… can be told from a lone "Track 2". */
  template?: string;
}

/** Below this a key is a guess: a bare number. */
export const WEAK_KEY = 0.5;

const SEP = "[\\s._\\-]";
/** Not glued to a letter or digit before it. */
const START = "(?:^|[^a-z0-9])";

const fullWidthDigits = (text: string) => text.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));

const isYear = (n: number) => n >= 1900 && n <= 2099;

/** A plausible end of a multi-episode range: after the start, and not so far
 *  after it that it is more likely a resolution or a year. */
const rangeEnd = (start: number, end: number | undefined) =>
  end !== undefined && end > start && end - start <= 24 ? end : undefined;

/** Technical tags whose numbers are never episodes. Removed before the
 *  looser patterns run; the explicit ones (S01E02, 1x02) carry their own
 *  marker and run on the raw name. */
const TECHNICAL: RegExp[] = [
  /\b\d{3,4}x\d{3,4}\b/g, // 1920x1080
  /\b\d{3,4}[pi]\b/g, // 1080p, 1080i
  /\b(?:4k|8k|uhd|fhd|hd)\b/g,
  /\b[hx][\s.]?26[45]\b/g, // x264, H.265
  /\b(?:hevc|avc|av1|vp9|xvid|divx)\b/g,
  /\b(?:dd\+?|ddp|eac3|e-?ac-?3|ac-?3|aac|dts(?:-?hd)?|truehd|atmos|flac|opus|mp3|l?pcm)(?:[\s._-]?\d(?:[._]\d)?)?\b/g, // DDP5.1, AAC2.0, E-AC-3
  /\b\d[._]\d\b/g, // 5.1, 2.0, 7.1
  /\b\d{1,2}[\s._-]?(?:bits?|ch)\b/g, // 10bit, 6ch
  /\b\d+(?:\.\d+)?\s*(?:fps|hz|khz|kbps|mbps|gb|mb)\b/g,
  /\b(?:19|20)\d{2}\b/g, // years
  /\[[0-9a-f]{8}\]/g, // [ABCD1234] release hash
  /\bv\d\b/g, // v2 of a release
];

function withoutTechnical(name: string): string {
  return TECHNICAL.reduce((text, pattern) => text.replace(pattern, " "), name);
}

/** The season a folder names: "Season 2", "S02", "Staffel 2", "Specials". */
function folderSeason(folder: string): number | undefined {
  const name = fullWidthDigits(folder.toLowerCase());
  if (/^(?:specials?|season[\s._-]*0+|s0+)$/.test(name.trim())) return 0;
  const named = name.match(new RegExp(`${START}(?:season|series|staffel|saison|temporada|stagione|seizoen)${SEP}*(\\d{1,2})(?![0-9])`));
  if (named) return Number(named[1]);
  // "Show.S02.1080p" season packs; not "S02E05", which names one episode.
  const short = name.match(new RegExp(`${START}s(\\d{1,2})(?![0-9])(?!${SEP}?e\\d)`));
  if (short) return Number(short[1]);
  const ordinal = name.match(/(\d{1,2})(?:st|nd|rd|th)[\s._-]*season/);
  return ordinal ? Number(ordinal[1]) : undefined;
}

/** A season named inside the file name without an episode marker beside it:
 *  "Show 2nd Season - 05", "Show S2 - 05", "Show Season 2 [05]". */
function nameSeason(name: string): number | undefined {
  const ordinal = name.match(/(\d{1,2})(?:st|nd|rd|th)[\s._-]*season/);
  if (ordinal) return Number(ordinal[1]);
  const named = name.match(new RegExp(`${START}season${SEP}*(\\d{1,2})(?![0-9])`));
  if (named) return Number(named[1]);
  const short = name.match(new RegExp(`${START}s(\\d{1,2})(?![0-9a-z])`));
  return short ? Number(short[1]) : undefined;
}

interface Found {
  season?: number;
  episode: number;
  episodeEnd?: number;
  confidence: number;
  template?: string;
}

/** The episode in a file name (no folders), or null. */
function fromName(stem: string): Found | null {
  const name = fullWidthDigits(stem.toLowerCase());

  // S01E02, S1E2, S01.E02, S01E01-E02, S01E01E02, S01E01-02.
  const sxe = name.match(new RegExp(`${START}s(\\d{1,2})${SEP}?e(\\d{1,4})((?:${SEP}?e\\d{1,4}|-\\d{1,4}(?![0-9pi]))*)`));
  if (sxe) {
    const episode = Number(sxe[2]);
    const tail = sxe[3].match(/\d{1,4}/g);
    return { season: Number(sxe[1]), episode, episodeEnd: rangeEnd(episode, tail ? Number(tail[tail.length - 1]) : undefined), confidence: 1 };
  }

  // Season 1 Episode 2.
  const spelled = name.match(new RegExp(`${START}season${SEP}*(\\d{1,2})${SEP}*(?:episode|ep)${SEP}*(\\d{1,4})(?![0-9])`));
  if (spelled) return { season: Number(spelled[1]), episode: Number(spelled[2]), confidence: 1 };

  // 1x02, 01x02, 1x01-1x02, 1x01-02. Not 1920x1080: the season is at most two
  // digits, and a codec's 264/265 is not an episode.
  const nx = name.match(new RegExp(`${START}(\\d{1,2})x(\\d{2,3})(?![0-9])((?:-(?:\\d{1,2}x)?\\d{2,3}(?![0-9]))?)`));
  if (nx && !["264", "265"].includes(nx[2])) {
    const episode = Number(nx[2]);
    const tail = nx[3].match(/\d{2,3}$/);
    return { season: Number(nx[1]), episode, episodeEnd: rangeEnd(episode, tail ? Number(tail[0]) : undefined), confidence: 0.95 };
  }

  const clean = withoutTechnical(name);
  const season = nameSeason(clean);

  // Specials: SP01, Special 2, OVA 3, OAD 1 are season 0.
  const special = clean.match(new RegExp(`${START}(?:sp|special|ova|oad)${SEP}*(\\d{1,3})(?![0-9])`));
  if (special) return { season: 0, episode: Number(special[1]), confidence: 0.8 };

  // 第2話, 第02集, 第3回 (Japanese and Chinese), 第1-2話.
  const cjk = clean.match(/第\s*(\d{1,4})(?:\s*[-~～]\s*(\d{1,4}))?\s*[話话集回]/);
  if (cjk) {
    const episode = Number(cjk[1]);
    return { season, episode, episodeEnd: rangeEnd(episode, cjk[2] ? Number(cjk[2]) : undefined), confidence: 0.9 };
  }

  // EP02, Ep 2, Episode 02, E02, #02, EP01-EP02.
  const marked = clean.match(new RegExp(`${START}(?:(?:episode|eps?|e)${SEP}*#?|#)(\\d{1,4})(?![0-9])(?:${SEP}?(?:-|~)${SEP}?(?:episode|eps?|e)?${SEP}*(\\d{1,4})(?![0-9]))?`));
  if (marked) {
    const episode = Number(marked[1]);
    const bareE = !/^(?:[^a-z0-9])?(?:episode|eps?)/.test(marked[0]);
    // "E2" alone is weaker than "Episode 2": a single letter is more often something else.
    return { season, episode, episodeEnd: rangeEnd(episode, marked[2] ? Number(marked[2]) : undefined), confidence: bareE ? 0.85 : 0.9 };
  }

  // Fansub style: "Show - 02", "Show - 02v2 [1080p]", "Show - 01-02".
  const dashed = clean.match(/\s-\s+(\d{1,4})(?:v\d)?(?![0-9])(?:\s*[-~]\s*(\d{1,4})(?:v\d)?(?![0-9]))?(?=[\s.[(_]|$)/);
  if (dashed && !isYear(Number(dashed[1]))) {
    const episode = Number(dashed[1]);
    return { season, episode, episodeEnd: rangeEnd(episode, dashed[2] ? Number(dashed[2]) : undefined), confidence: 0.8 };
  }

  // A number in brackets: "[02]", "(02)".
  const bracketed = clean.match(/[[(]\s*(\d{1,4})(?:v\d)?\s*[\])]/);
  if (bracketed && !isYear(Number(bracketed[1]))) return { season, episode: Number(bracketed[1]), confidence: 0.75 };

  // Last resort: a bare number, the last one in the name. Weak on its own.
  const tokens = clean.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (!/^\d{1,3}$/.test(tokens[i])) continue;
    const template = [...tokens.slice(0, i), "#", ...tokens.slice(i + 1)].join(" ");
    return { season, episode: Number(tokens[i]), confidence: 0.4, template };
  }
  return null;
}

const NONE: EpisodeKey = { confidence: 0 };

/** The season and episode of a file, from its name and up to two parent
 *  folders. Takes a path (either separator) or a bare name. */
export function episodeKey(pathOrName: string): EpisodeKey {
  const parts = pathOrName.split(/[\\/]+/).filter(Boolean);
  const file = parts.pop();
  if (!file) return NONE;
  const stem = file.replace(/\.[a-z0-9]{1,5}$/i, "");
  const found = fromName(stem);
  // Episode 0 is a real pilot or special, but only an explicit S01E00 says so.
  if (!found || found.episode < 0 || (found.episode === 0 && found.confidence < 0.9)) return NONE;

  let season = found.season;
  if (season === undefined) {
    for (const folder of parts.slice(-2).reverse()) {
      season = folderSeason(folder);
      if (season !== undefined) break;
    }
  }
  return {
    ...(season !== undefined ? { season } : {}),
    episode: found.episode,
    ...(found.episodeEnd !== undefined ? { episodeEnd: found.episodeEnd } : {}),
    confidence: found.confidence,
    ...(found.template !== undefined ? { template: found.template } : {}),
  };
}

/** "S01E02", "S01E01–E02", or "episode 2" when the season is not known. */
export function formatEpisodeKey(key: EpisodeKey): string {
  if (key.episode === undefined) return "no episode";
  const pad = (n: number) => String(n).padStart(2, "0");
  const end = key.episodeEnd !== undefined ? `–E${pad(key.episodeEnd)}` : "";
  if (key.season === undefined) return key.episodeEnd !== undefined ? `episodes ${key.episode}–${key.episodeEnd}` : `episode ${key.episode}`;
  return `S${pad(key.season)}E${pad(key.episode)}${end}`;
}
