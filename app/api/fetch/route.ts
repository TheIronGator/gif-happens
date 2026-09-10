import { execFile } from "child_process";
import { join } from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

type Quality = "360" | "720" | "1080";

interface FetchBody {
  url?: unknown;
  quality?: unknown;
  includeThumbnail?: unknown;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

const QUALITY_HEIGHT: Record<Quality, number> = {
  "360": 360,
  "720": 720,
  "1080": 1080,
};

const BIN_PATH = join(process.cwd(), "bin", "yt-dlp");
const TIMEOUT_MS = 30_000;

// Volunteer-run Piped API instances used ONLY as a fallback when YouTube
// bot-blocks the server's own yt-dlp extraction. Instances come and go;
// dead ones are skipped quickly.
const PIPED_INSTANCES = ["https://api.piped.private.coffee"];

/** Extract the 11-char video id from common YouTube URL shapes. */
function youtubeVideoId(urlRaw: string): string | null {
  try {
    const u = new URL(urlRaw);
    const host = u.hostname.toLowerCase();
    const idOk = (s: string | null) => !!s && /^[A-Za-z0-9_-]{11}$/.test(s);
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? null;
      return idOk(id) ? id : null;
    }
    if (YOUTUBE_HOSTS.has(host)) {
      const v = u.searchParams.get("v");
      if (idOk(v)) return v;
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* fall through */
  }
  return null;
}

interface PipedPayload {
  ok: true;
  title: string;
  downloadUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  width: null;
  height: number;
  ext: string;
  sourceType: "youtube";
  note: string;
}

/** Try Piped API instances for a YouTube id. Returns a payload or null. */
async function tryPipedFallback(
  videoId: string,
  maxHeight: number,
  includeThumbnail: boolean
): Promise<PipedPayload | null> {
  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(`${base}/streams/${videoId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        title?: unknown;
        duration?: unknown;
        thumbnailUrl?: unknown;
        videoStreams?: { quality?: unknown; videoOnly?: unknown; url?: unknown }[];
      };
      const cands: { h: number; url: string }[] = [];
      for (const s of data.videoStreams ?? []) {
        if (s.videoOnly !== false || typeof s.url !== "string") continue;
        const m = /^(\d{3,4})p$/.exec(typeof s.quality === "string" ? s.quality : "");
        if (!m) continue;
        const h = parseInt(m[1], 10);
        if (h <= maxHeight) cands.push({ h, url: s.url });
      }
      cands.sort((a, b) => b.h - a.h);
      if (!cands.length) continue;
      const best = cands[0];
      return {
        ok: true,
        title: typeof data.title === "string" ? data.title : "Untitled clip",
        downloadUrl: best.url,
        thumbnailUrl:
          includeThumbnail && typeof data.thumbnailUrl === "string"
            ? data.thumbnailUrl
            : null,
        durationSeconds: typeof data.duration === "number" ? data.duration : null,
        width: null,
        height: best.h,
        ext: "mp4",
        sourceType: "youtube",
        note:
          best.h < maxHeight
            ? `Best available via fallback extractor was ${best.h}p`
            : "Fetched via fallback extractor",
      };
    } catch {
      /* try next instance */
    }
  }
  return null;
}

/** Run the bundled yt-dlp binary. Resolves with stdout, or rejects with an Error whose message is provider output. */
function runYtdlp(args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(BIN_PATH, args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const output = String(stdout ?? "").trim();
        const errMsg = err.message ?? "";
        const combined = [errMsg, output].filter(Boolean).join("\n");
        const timeout = /timed out|ETIMEDOUT/i.test(combined);
        const e = new Error(timeout ? "__TIMEOUT__" : combined || "yt-dlp failed with no output");
        reject(e);
        return;
      }
      resolve({ stdout: String(stdout ?? "") });
    });
  });
}

function classifyError(hostType: "youtube" | "instagram" | "tiktok", text: string): string {
  const t = text;
  if (hostType === "youtube") {
    // YouTube's bot challenge mentions "sign in", so it must be checked
    // BEFORE the generic login/private patterns.
    if (/not a bot|confirm you.{0,5}re not a bot/i.test(t))
      return "YouTube is blocking automated downloads from this server at the moment. Wait a few minutes and try again.";
    if (/private video/i.test(t))
      return "YouTube says this video is private — only public videos can be fetched.";
    if (/login required|sign in/i.test(t))
      return "YouTube needs a login for this video (it's private or age-restricted). Only public, unrestricted videos can be fetched.";
  } else if (hostType === "instagram") {
    if (/login required|not logged in/i.test(t))
      return "Instagram is blocking anonymous downloads for this post. Only some public posts/reels can be fetched without logging in.";
  } else {
    // TikTok
    if (/private/i.test(t))
      return "TikTok says this video is private — only public videos can be fetched.";
    if (/login required|not logged in|sign in/i.test(t))
      return "TikTok needs a login for this video. Only public videos can be fetched without logging in.";
  }
  if (/HTTP Error 429|rate-limit/i.test(t))
    return "The video source is rate-limiting requests right now. Wait a few minutes and try again.";
  if (/Unsupported URL/i.test(t)) return "That URL isn't a supported video link.";
  if (/__TIMEOUT__|ETIMEDOUT|timed out/i.test(t))
    return "The request timed out talking to the video source. Try again.";

  // Fallback: first meaningful line of yt-dlp's error, max 180 chars.
  const line =
    t
      .split("\n")
      .map((l) => l.replace(/^\s*(ERROR:\s*)?/, "").trim())
      .find((l) => l.length > 0) ?? "unknown error";
  return `Couldn't fetch that link: ${line.slice(0, 180)}`;
}

export async function POST(req: Request): Promise<Response> {
  let body: FetchBody;
  try {
    body = (await req.json()) as FetchBody;
  } catch {
    return Response.json({ ok: false, error: "Request body must be JSON." }, { status: 400 });
  }

  const urlRaw = typeof body.url === "string" ? body.url.trim() : "";
  const quality: Quality = body.quality === "360" || body.quality === "1080" ? body.quality : "720";
  const includeThumbnail = body.includeThumbnail === true;

  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "That doesn't look like a YouTube, TikTok, or Instagram link. Paste a YouTube watch/shorts URL, a TikTok video URL, or a public Instagram post/reel URL.",
      },
      { status: 400 }
    );
  }

  const host = parsed.hostname.toLowerCase();
  const sourceType: "youtube" | "instagram" | "tiktok" | null = YOUTUBE_HOSTS.has(host)
    ? "youtube"
    : INSTAGRAM_HOSTS.has(host)
      ? "instagram"
      : TIKTOK_HOSTS.has(host)
        ? "tiktok"
        : null;

  if (!sourceType) {
    return Response.json(
      {
        ok: false,
        error:
          "That doesn't look like a YouTube, TikTok, or Instagram link. Paste a YouTube watch/shorts URL, a TikTok video URL, or a public Instagram post/reel URL.",
      },
      { status: 400 }
    );
  }

  const maxHeight = QUALITY_HEIGHT[quality];
  // Progressive single-file MP4 only — deliberately no merging, so no ffmpeg
  // is needed server-side.
  const selector = `b[height<=${maxHeight}][ext=mp4]/b[height<=${maxHeight}]/b[ext=mp4]/b`;
  const baseArgs = ["--no-playlist", "--no-warnings", "--dump-json", "--socket-timeout", "20"];

  const attempts: string[][] = [[...baseArgs, "-f", selector, urlRaw]];
  if (sourceType === "youtube") {
    // Different player clients hit different YouTube endpoints; web is the
    // most bot-checked, so fall through android -> ios on failure.
    for (const client of ["android", "ios"]) {
      attempts.push([
        ...baseArgs,
        "--extractor-args",
        `youtube:player_client=${client}`,
        "-f",
        selector,
        urlRaw,
      ]);
    }
  }

  let lastErrorText = "";
  for (const args of attempts) {
    try {
      const { stdout } = await runYtdlp(args);
      const json = JSON.parse(stdout);
      if (!json || typeof json.url !== "string" || json.url.length === 0) {
        lastErrorText = "yt-dlp returned metadata without a playable URL.";
        continue;
      }

      const achievedHeight: number | null = typeof json.height === "number" ? json.height : null;
      const note =
        achievedHeight !== null && achievedHeight < maxHeight
          ? `Best progressive MP4 available was ${achievedHeight}p`
          : undefined;

      const payload: Record<string, unknown> = {
        ok: true,
        title: typeof json.title === "string" ? json.title : "Untitled clip",
        downloadUrl: json.url,
        thumbnailUrl:
          includeThumbnail && typeof json.thumbnail === "string" ? json.thumbnail : null,
        durationSeconds: typeof json.duration === "number" ? json.duration : null,
        width: typeof json.width === "number" ? json.width : null,
        height: achievedHeight,
        ext: typeof json.ext === "string" ? json.ext : null,
        sourceType,
      };
      if (note) payload.note = note;
      return Response.json(payload, { status: 200 });
    } catch (err) {
      lastErrorText = err instanceof Error ? err.message : String(err);
    }
  }

  // YouTube bot-blocks / rate-limits are often transient and IP-specific, so
  // retry through a Piped API instance (different egress IP) before giving up.
  // Genuinely private / login-walled / unsupported links skip this.
  if (
    sourceType === "youtube" &&
    /not a bot|confirm you.{0,5}re not a bot|HTTP Error 429|rate-limit|timed out|__TIMEOUT__/i.test(
      lastErrorText
    )
  ) {
    const videoId = youtubeVideoId(urlRaw);
    if (videoId) {
      const piped = await tryPipedFallback(videoId, maxHeight, includeThumbnail);
      if (piped) return Response.json(piped, { status: 200 });
    }
  }

  return Response.json({ ok: false, error: classifyError(sourceType, lastErrorText) }, { status: 200 });
}
