FFmpeg (`ffmpeg` and `ffprobe`) is fetched into this directory by
`npm run fetch-ffmpeg`; the binaries are build artifacts and are not committed.

Release builds bundle them so that delay measurement works on a machine that
has never installed FFmpeg. In a development checkout this directory is usually
empty, and the app falls back to whatever `ffmpeg`/`ffprobe` are on your PATH.
