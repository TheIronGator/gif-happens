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

const QUALITY_HEIGHT: Record<Quality, number> = {
  "360": 360,
  "720": 720,
  "1080": 1080,
};

const BIN_PATH = join(process.cwd(), "bin", "yt-dlp");
const TIMEOUT_MS = 50_000;

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

function classifyError(hostType: "youtube" | "instagram", text: string): string {
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
  } else {
    if (/login required|not logged in/i.test(t))
      return "Instagram is blocking anonymous downloads for this post. Only some public posts/reels can be fetched without logging in.";
  }
  if (/HTTP Error 429|rate-limit/i.test(t))
    return "YouTube is rate-limiting requests right now. Wait a few minutes and try again.";
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
          "That doesn't look like a YouTube or Instagram link. Paste a YouTube watch/shorts URL or a public Instagram post/reel URL.",
      },
      { status: 400 }
    );
  }

  const host = parsed.hostname.toLowerCase();
  const sourceType: "youtube" | "instagram" | null = YOUTUBE_HOSTS.has(host)
    ? "youtube"
    : INSTAGRAM_HOSTS.has(host)
      ? "instagram"
      : null;

  if (!sourceType) {
    return Response.json(
      {
        ok: false,
        error:
          "That doesn't look like a YouTube or Instagram link. Paste a YouTube watch/shorts URL or a public Instagram post/reel URL.",
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
    // most bot-checked, so fall through android -> ios -> tv on failure.
    for (const client of ["android", "ios", "tv"]) {
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

  return Response.json({ ok: false, error: classifyError(sourceType, lastErrorText) }, { status: 200 });
}
