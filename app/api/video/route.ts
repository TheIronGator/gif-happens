export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Same-origin relay for video bytes. The GIF Studio fetches clip bytes
 * straight from the video host in the browser (fast path), but some hosts
 * refuse cross-origin browser requests — this endpoint streams the bytes
 * through our server instead so the studio always gets its file.
 *
 * `u` must be an https URL on a known video CDN host. The URLs we relay
 * come from our own /api/fetch (yt-dlp / Piped output); the allowlist is a
 * sanity fence against open-proxy abuse.
 */
const ALLOWED_SUFFIXES = [
  "googlevideo.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "tiktokcdn-us.com",
  "akamaized.net",
  "cdninstagram.com",
  "fbcdn.net",
  "instagram.com",
  "tiktok.com",
];

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("u") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return Response.json({ error: "Missing or invalid video URL." }, { status: 400 });
  }
  if (parsed.protocol !== "https:" || !hostAllowed(parsed.hostname)) {
    return Response.json({ error: "That video host can't be relayed." }, { status: 400 });
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(55_000),
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: `The video host responded with ${upstream.status}.` },
        { status: 502 }
      );
    }
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) headers.set("content-length", cl);
    headers.set("cache-control", "no-store");
    // Stream the body through — never buffered in memory.
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return Response.json({ error: "Couldn't reach the video host." }, { status: 502 });
  }
}
