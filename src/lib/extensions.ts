/**
 * Comprehensive file extension lists for MKV Batch Muxing Tool
 * These extensions are used for file filtering and validation
 */

export const VIDEO_EXTENSIONS = [
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "mpeg",
  "mpg",
  "ts",
  "m2ts",
  "mts",
  "ogv",
  "ogg",
  "ogm",
  "webm",
  "wmv",
  "asf",
  "flv",
  "f4v",
  "h264",
  "h265",
  "hevc",
  "avc",
  "264",
  "265",
  "3gp",
  "3g2",
] as const;

export const AUDIO_EXTENSIONS = [
  "aac",
  "ac3",
  "eac3",
  "ec3",
  "dts",
  "dtsma",
  "dtshd",
  "thd",
  "truehd",
  "flac",
  "mp3",
  "m4a",
  "mp4", // audio-only MP4
  "mka",
  "ogg",
  "opus",
  "wav",
  "wma",
  "ape",
  "tak",
  "tta",
  "wv",
] as const;

export const SUBTITLE_EXTENSIONS = [
  "srt",
  "ass",
  "ssa",
  "vtt",
  "sup",
  "pgs",
  "sub",
  "idx",
  "mks",
  "usf",
  "xml", // for subtitle XML
] as const;

export const CHAPTER_EXTENSIONS = [
  "xml",
  "txt",
  "ogm",
] as const;

export const ATTACHMENT_EXTENSIONS = [
  "ttf",
  "otf",
  "woff",
  "woff2",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "ico",
  "txt",
  "nfo",
  "xml",
] as const;

export function getAllExtensions(type: 'video' | 'audio' | 'subtitle' | 'chapter' | 'attachment'): readonly string[] {
  switch (type) {
    case 'video':
      return VIDEO_EXTENSIONS;
    case 'audio':
      return AUDIO_EXTENSIONS;
    case 'subtitle':
      return SUBTITLE_EXTENSIONS;
    case 'chapter':
      return CHAPTER_EXTENSIONS;
    case 'attachment':
      return ATTACHMENT_EXTENSIONS;
    default:
      return [];
  }
}

export function isValidExtension(ext: string, type: 'video' | 'audio' | 'subtitle' | 'chapter' | 'attachment'): boolean {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  const validExtensions = getAllExtensions(type);
  return validExtensions.some((item) => item === normalized);
}
