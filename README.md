# 🎬 Gif Happens

Turn any clip into a perfect GIF — plus a YouTube / Instagram clip fetcher. Phone-first web app built with Next.js 14, React 18, and TypeScript.

## What it is

- **GIF Studio** — drop in a video, trim it, tune FPS / width / colors / dithering, get a realistic sample-based size estimate that auto-tightens settings to hit your target file size, then render a two-pass palette GIF entirely in the browser.
- **Fetch Clip** — paste a YouTube watch/shorts URL or a public Instagram post/reel URL, pick a quality, and get a direct playable MP4 link. Save the video, download the thumbnail, or load the clip straight into the GIF trimmer.

## How the fetch endpoint works

`POST /api/fetch` (`app/api/fetch/route.ts`) shells out to a **yt-dlp standalone Linux binary that is bundled at build time** — never proxied video bytes:

1. `scripts/fetch-ytdlp.mjs` downloads the pinned yt-dlp binary (`2026.08.19`) into `<repo>/bin/yt-dlp` during the Vercel build (idempotent; fails the build loudly if the download or version check fails).
2. At request time the route validates the URL is YouTube or Instagram, then runs the bundled binary with `--dump-json` and a **progressive single-file MP4 format selector** (deliberately no merging, so no ffmpeg is needed server-side).
3. The handler parses the JSON, pulls the direct playable media URL, and returns `{ ok, title, downloadUrl, thumbnailUrl, durationSeconds, width, height, ext, sourceType, note? }`. It never proxies video bytes — the browser streams/downloads straight from the source.

## Vercel deploy

Push this repo to GitHub and import it in Vercel. `vercel.json` sets the build command:

```
node scripts/fetch-ytdlp.mjs && next build
```

and gives `/api/fetch` a 60s function duration. No COOP/COEP headers are needed: GIF rendering uses the single-threaded `@ffmpeg/core-st` build, lazily loaded from CDN only when the user first requests an estimate or conversion.

## Local dev

```bash
npm install
node scripts/fetch-ytdlp.mjs   # only needed to test /api/fetch locally
npm run dev
```
