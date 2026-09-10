"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

/* ------------------------------------------------------------------ */
/* 90s hip-hop quotes shown while work is in progress                   */
/* ------------------------------------------------------------------ */
const QUOTES: { line: string; artist: string }[] = [
  { line: "It was all a dream…", artist: "The Notorious B.I.G." },
  { line: "Can't touch this.", artist: "MC Hammer" },
  { line: "Straight outta Compton!", artist: "N.W.A" },
  { line: "Fight the power!", artist: "Public Enemy" },
  { line: "Jump around!", artist: "House of Pain" },
  { line: "Insane in the brain!", artist: "Cypress Hill" },
  { line: "Baby got back.", artist: "Sir Mix-a-Lot" },
  { line: "California love!", artist: "2Pac" },
  { line: "Regulators, mount up.", artist: "Warren G" },
  { line: "Sabotage!", artist: "Beastie Boys" },
  { line: "Push it real good.", artist: "Salt-N-Pepa" },
  { line: "Whoomp! There it is.", artist: "Tag Team" },
  { line: "99 problems but a GIF ain't one.", artist: "Gif Happens remix" },
  { line: "It ain't nothin' but a GIF thang.", artist: "Gif Happens remix" },
];

// The ffmpeg core is self-hosted (see public/ffmpeg-core): same-origin
// files, no CDN dependency at runtime. wrapper.js injects `locateFile`
// so the core-st@0.11.1 wasm resolves to the right file.
const CORE_ST_BASE = "/ffmpeg-core";
const WIDTH_OPTIONS = [160, 240, 320, 480, 640];
const COLOR_OPTIONS = [64, 96, 128, 192, 256];

interface GifSettings {
  fps: number;
  width: number;
  colors: number;
  dither: boolean;
  targetMB: number;
}

interface FetchResult {
  ok: true;
  title: string;
  downloadUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  ext: string | null;
  sourceType: "youtube" | "instagram" | "tiktok";
  note?: string;
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatSeconds(s: number | null): string {
  if (s === null || !isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

function sanitizeFileName(name: string): string {
  const clean = name.replace(/[^\w\- ]+/g, "").trim().slice(0, 60);
  return clean.length > 0 ? clean : "gif-happens";
}

/** Rotating quote bar with CSS fade, shown during long operations. */
function QuoteBar({ active }: { active: boolean }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % QUOTES.length), 2800);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const q = QUOTES[idx];
  return (
    <div className="quote">
      <span key={idx} className="quote-fade">
        “{q.line}” <span className="artist">— {q.artist}</span>
      </span>
    </div>
  );
}

export default function Home() {
  /* ---------------- GIF Studio state ---------------- */
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  const [settings, setSettings] = useState<GifSettings>({
    fps: 12,
    width: 320,
    colors: 128,
    dither: true,
    targetMB: 8,
  });

  const [engineLoading, setEngineLoading] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimateBytes, setEstimateBytes] = useState<number | null>(null);
  const [effectiveSettings, setEffectiveSettings] = useState<GifSettings | null>(null);
  const [tightenNote, setTightenNote] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const inputBlobRef = useRef<Blob | null>(null);
  const inputNameRef = useRef<string>("input.mp4");
  const estimateRunId = useRef(0);

  /* ---------------- Fetch Clip state ---------------- */
  const [clipUrl, setClipUrl] = useState("");
  const [clipQuality, setClipQuality] = useState<"360" | "720" | "1080">("720");
  const [clipThumb, setClipThumb] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);
  const [loadMsg, setLoadMsg] = useState<string | null>(null);
  const [loadingClip, setLoadingClip] = useState(false);
  const fetchCancelRef = useRef(false);

  const studioRef = useRef<HTMLDivElement>(null);
  // Trimmer preview video — the in/out sliders seek this so you see the exact frame.
  const trimVideoRef = useRef<HTMLVideoElement | null>(null);

  /* ---------------- video loading ---------------- */

  /** Load a Blob programmatically (file input, drag-drop, or Fetch Clip). */
  const loadVideoBlob = useCallback((blob: Blob, name: string) => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const url = URL.createObjectURL(blob);
    setVideoUrl(url);
    setFileName(name);
    inputBlobRef.current = blob;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "mp4";
    inputNameRef.current = `input.${ext}`;
    // Reset per-video state; trim defaults are set when metadata loads.
    setTrimStart(0);
    setTrimEnd(0);
    setGifUrl(null);
    setEstimateBytes(null);
    setEffectiveSettings(null);
    setTightenNote(null);
    setStudioError(null);
  }, [videoUrl]);

  const onVideoMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const d = e.currentTarget.duration;
    if (isFinite(d) && d > 0) {
      setDuration(d);
      setTrimStart(0);
      setTrimEnd(d);
    }
  }, []);

  const handleFile = useCallback(
    (f: File | undefined | null) => {
      if (f) loadVideoBlob(f, f.name);
    },
    [loadVideoBlob]
  );

  /* ---------------- ffmpeg lazy load ---------------- */

  const ensureEngine = useCallback(async (): Promise<FFmpeg> => {
    if (ffmpegRef.current) return ffmpegRef.current;
    setEngineLoading(true);
    try {
      // The core is self-hosted (public/ffmpeg-core, downloaded at build
      // time). We use our own static class-worker (also in public/) instead
      // of the bundled @ffmpeg/ffmpeg worker: the bundler rewrites that
      // worker's dynamic core import into a broken chunk lookup, and build
      // caches can resurrect the broken version. The static worker loads the
      // core with a native import, which just works. wrapper.js injects
      // `locateFile` so the core-st@0.11.1 wasm resolves to the right file.
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        classWorkerURL: `${CORE_ST_BASE}/worker.js`,
        coreURL: `${CORE_ST_BASE}/wrapper.js`,
        wasmURL: `${CORE_ST_BASE}/ffmpeg-core.wasm`,
      });
      ffmpegRef.current = ffmpeg;
      return ffmpeg;
    } catch (err) {
      // The ffmpeg worker rejects with plain strings, not Errors — wrap so
      // the real cause reaches the UI instead of a generic message.
      throw new Error(
        `Video engine failed to start: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setEngineLoading(false);
    }
  }, []);

  const ensureInputWritten = useCallback(async (ffmpeg: FFmpeg) => {
    const blob = inputBlobRef.current;
    if (!blob) throw new Error("No video loaded.");
    const name = inputNameRef.current;
    await ffmpeg.writeFile(name, await fetchFile(blob));
  }, []);

  const safeDelete = useCallback(async (ffmpeg: FFmpeg, name: string) => {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* file may not exist — fine */
    }
  }, []);

  const ditherArg = (dither: boolean) => (dither ? "bayer:bayer_scale=5" : "none");

  /** Encode a ~2s sample from the middle of the trim range; return GIF byte size. */
  const encodeSampleBytes = useCallback(
    async (ffmpeg: FFmpeg, s: GifSettings, start: number, end: number): Promise<number> => {
      const trimDur = Math.max(0.5, end - start);
      const sampleDur = Math.min(2, trimDur);
      const sampleStart = start + Math.max(0, (trimDur - sampleDur) / 2);
      const input = inputNameRef.current;
      const vf = `fps=${s.fps},scale=${s.width}:-1:flags=lanczos`;
      await safeDelete(ffmpeg, "palette.png");
      await safeDelete(ffmpeg, "sample.gif");
      await ffmpeg.exec([
        "-ss",
        sampleStart.toFixed(2),
        "-t",
        sampleDur.toFixed(2),
        "-i",
        input,
        "-vf",
        `${vf},palettegen=max_colors=${s.colors}`,
        "palette.png",
      ]);
      await ffmpeg.exec([
        "-ss",
        sampleStart.toFixed(2),
        "-t",
        sampleDur.toFixed(2),
        "-i",
        input,
        "-i",
        "palette.png",
        "-lavfi",
        `${vf}[x];[x][1:v]paletteuse=dither=${ditherArg(s.dither)}`,
        "sample.gif",
      ]);
      const data = await ffmpeg.readFile("sample.gif");
      return data instanceof Uint8Array ? data.byteLength : 0;
    },
    [safeDelete]
  );

  /** Sequence of tightened candidate settings after the initial encode. */
  const tightenSequence = useCallback((base: GifSettings): GifSettings[] => {
    const seq: GifSettings[] = [];
    let cur = { ...base };
    // 1) width down
    for (const w of [640, 480, 320, 240, 160]) {
      if (w < cur.width) {
        cur = { ...cur, width: w };
        seq.push(cur);
      }
    }
    // 2) fps down to 8
    while (cur.fps > 8) {
      cur = { ...cur, fps: Math.max(8, cur.fps - 2) };
      seq.push(cur);
    }
    // 3) colors down to 64
    for (const c of [192, 128, 96, 64]) {
      if (c < cur.colors) {
        cur = { ...cur, colors: c };
        seq.push(cur);
      }
    }
    return seq;
  }, []);

  /* ---------------- realistic size estimate ---------------- */

  const runEstimate = useCallback(async () => {
    const myRun = ++estimateRunId.current;
    if (!inputBlobRef.current || duration <= 0) return;
    setEstimating(true);
    setStudioError(null);
    try {
      const ffmpeg = await ensureEngine();
      if (myRun !== estimateRunId.current) return;
      await ensureInputWritten(ffmpeg);
      const start = Math.min(trimStart, trimEnd - 0.5);
      const end = Math.max(trimEnd, trimStart + 0.5);
      const trimDur = end - start;
      const targetBytes = settings.targetMB * 1024 * 1024;

      const bytesFor = async (s: GifSettings): Promise<number> => {
        const sampleBytes = await encodeSampleBytes(ffmpeg, s, start, end);
        return sampleBytes * (trimDur / Math.min(2, trimDur));
      };

      let finalSettings = { ...settings };
      let estBytes = await bytesFor(finalSettings);
      let encodes = 1;
      const MAX_ENCODES = 8;

      if (estBytes > targetBytes) {
        for (const candidate of tightenSequence(settings)) {
          if (myRun !== estimateRunId.current) return;
          if (encodes >= MAX_ENCODES) break;
          const b = await bytesFor(candidate);
          encodes += 1;
          finalSettings = candidate;
          estBytes = b;
          if (estBytes <= targetBytes) break;
        }
      }

      if (myRun !== estimateRunId.current) return;
      setEffectiveSettings(finalSettings);
      setEstimateBytes(estBytes);
      const tightened =
        finalSettings.width !== settings.width ||
        finalSettings.fps !== settings.fps ||
        finalSettings.colors !== settings.colors;
      setTightenNote(
        tightened
          ? `Tightened to fit ${settings.targetMB} MB: ${finalSettings.width}px · ${finalSettings.fps}fps · ${finalSettings.colors} colors`
          : null
      );
    } catch (err) {
      if (myRun !== estimateRunId.current) return;
      // The ffmpeg worker can reject with plain strings; show the real cause.
      const msg = err instanceof Error ? err.message : String(err);
      setStudioError(msg || "Something went wrong while estimating the GIF size.");
    } finally {
      if (myRun === estimateRunId.current) setEstimating(false);
    }
  }, [duration, trimStart, trimEnd, settings, ensureEngine, ensureInputWritten, encodeSampleBytes, tightenSequence]);

  // Debounced estimate when settings / trim / video change (~600ms).
  useEffect(() => {
    if (!videoUrl || duration <= 0) return;
    const id = setTimeout(() => {
      void runEstimate();
    }, 600);
    return () => clearTimeout(id);
  }, [videoUrl, duration, trimStart, trimEnd, settings, runEstimate]);

  /* ---------------- conversion ---------------- */

  const convert = useCallback(async () => {
    if (!inputBlobRef.current || converting) return;
    setConverting(true);
    setConvertProgress(0);
    setStudioError(null);
    setGifUrl(null);
    try {
      // Make sure the estimate (and any auto-tightening) is current.
      let finalSettings = effectiveSettings;
      if (!finalSettings) {
        await runEstimate();
        finalSettings = effectiveSettings;
      }
      const s: GifSettings = finalSettings ?? settings;
      const ffmpeg = await ensureEngine();
      await ensureInputWritten(ffmpeg);

      const start = Math.min(trimStart, trimEnd - 0.5);
      const end = Math.max(trimEnd, trimStart + 0.5);
      const dur = end - start;
      const input = inputNameRef.current;
      const vf = `fps=${s.fps},scale=${s.width}:-1:flags=lanczos`;

      const onProgress = ({ progress }: { progress: number }) => {
        const pass = (onProgress as { pass?: number }).pass ?? 0;
        const p = Math.min(1, Math.max(0, progress));
        setConvertProgress((pass + p) / 2);
      };
      ffmpeg.on("progress", onProgress);

      try {
        (onProgress as { pass?: number }).pass = 0;
        await safeDelete(ffmpeg, "palette.png");
        await safeDelete(ffmpeg, "out.gif");
        await ffmpeg.exec([
          "-ss",
          start.toFixed(2),
          "-t",
          dur.toFixed(2),
          "-i",
          input,
          "-vf",
          `${vf},palettegen=max_colors=${s.colors}`,
          "palette.png",
        ]);
        (onProgress as { pass?: number }).pass = 1;
        await ffmpeg.exec([
          "-ss",
          start.toFixed(2),
          "-t",
          dur.toFixed(2),
          "-i",
          input,
          "-i",
          "palette.png",
          "-lavfi",
          `${vf}[x];[x][1:v]paletteuse=dither=${ditherArg(s.dither)}`,
          "out.gif",
        ]);
      } finally {
        ffmpeg.off("progress", onProgress);
      }

      const data = await ffmpeg.readFile("out.gif");
      const blob = new Blob([data as unknown as BlobPart], { type: "image/gif" });
      if (gifUrl) URL.revokeObjectURL(gifUrl);
      setGifUrl(URL.createObjectURL(blob));
      setConvertProgress(1);
    } catch (err) {
      // The ffmpeg worker can reject with plain strings; show the real cause.
      const msg = err instanceof Error ? err.message : String(err);
      setStudioError(msg || "Something went wrong while making your GIF.");
    } finally {
      setConverting(false);
    }
  }, [converting, effectiveSettings, settings, trimStart, trimEnd, runEstimate, ensureEngine, ensureInputWritten, safeDelete, gifUrl]);

  /* ---------------- Fetch Clip ---------------- */

  // Errors worth retrying: YouTube's bot wall / rate limits are intermittent,
  // and each retry is a fresh serverless invocation (possibly a new egress IP).
  const BLOCKED_RETRY = /blocking automated downloads|rate-limiting|timed out/i;
  const MAX_FETCH_ATTEMPTS = 6;
  const RETRY_DELAYS_MS = [8000, 12000, 18000, 25000, 35000];

  /** True for youtube.com / youtu.be links — only these get the retry loop. */
  const isYouTubeLink = (raw: string) => {
    try {
      const h = new URL(raw).hostname.toLowerCase();
      return (
        h === "youtube.com" ||
        h === "www.youtube.com" ||
        h === "m.youtube.com" ||
        h === "music.youtube.com" ||
        h === "youtu.be"
      );
    } catch {
      return false;
    }
  };

  /** Sleep that aborts early if the user hits Cancel. */
  const cancellableSleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (fetchCancelRef.current || Date.now() - start >= ms) resolve();
        else setTimeout(tick, 250);
      };
      tick();
    });

  const fetchClip = useCallback(async () => {
    const url = clipUrl.trim();
    if (!url || fetching) return;
    // Retry loop is YouTube-only; Instagram etc. keep the normal single attempt.
    const youtube = isYouTubeLink(url);
    const maxAttempts = youtube ? MAX_FETCH_ATTEMPTS : 1;
    fetchCancelRef.current = false;
    setFetching(true);
    setFetchError(null);
    setFetchResult(null);
    setFetchStatus(null);
    setLoadMsg(null);
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (fetchCancelRef.current) return;
        setFetchStatus(
          attempt === 1 ? "Contacting the source…" : `Attempt ${attempt} of ${maxAttempts}…`
        );
        let data: FetchResult | { ok: false; error: string };
        try {
          const res = await fetch("/api/fetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, quality: clipQuality, includeThumbnail: clipThumb }),
          });
          data = (await res.json()) as FetchResult | { ok: false; error: string };
        } catch {
          data = { ok: false, error: "Couldn't reach the fetch service. Check your connection and try again." };
        }
        if (data.ok) {
          setFetchResult(data);
          return;
        }
        const errMsg = data.error || "Couldn't fetch that link.";
        const retriable = youtube && BLOCKED_RETRY.test(errMsg);
        if (!retriable || attempt === maxAttempts) {
          setFetchError(
            attempt === maxAttempts && retriable
              ? `Tried ${maxAttempts} times — YouTube is still blocking automated downloads from the server. Try again in a few minutes, or send the link to me directly and I'll grab it for you.`
              : errMsg
          );
          return;
        }
        const waitMs = RETRY_DELAYS_MS[attempt - 1] ?? 35000;
        setFetchStatus(
          `Attempt ${attempt} of ${maxAttempts} bounced off YouTube's wall — trying again in ${Math.round(waitMs / 1000)}s…`
        );
        await cancellableSleep(waitMs);
      }
    } finally {
      setFetching(false);
      setFetchStatus(null);
    }
  }, [clipUrl, clipQuality, clipThumb, fetching]);

  const loadClipIntoTrimmer = useCallback(async () => {
    if (!fetchResult) return;
    setLoadingClip(true);
    setLoadMsg(null);
    try {
      const res = await fetch(fetchResult.downloadUrl);
      if (!res.ok) throw new Error("bad response");
      const blob = await res.blob();
      const name = `${sanitizeFileName(fetchResult.title)}.${fetchResult.ext ?? "mp4"}`;
      loadVideoBlob(blob, name);
      setLoadMsg("Clip loaded into the GIF trimmer above. ✨");
      studioRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      setLoadMsg(
        "Couldn't pull the clip straight into the trimmer (the video host blocked the browser request). Use Save Video, then drop the file into the studio above."
      );
    } finally {
      setLoadingClip(false);
    }
  }, [fetchResult, loadVideoBlob]);

  const busy = fetching || converting || estimating || engineLoading;
  const trimDur = Math.max(0, trimEnd - trimStart);

  return (
    <div className="page-wrap">
      <main className="card">
        <header className="header">
          <h1>🎬 Gif Happens</h1>
          <p>Turn any clip into a perfect GIF — it happens. ✨</p>
        </header>

        {/* ================= GIF STUDIO ================= */}
        <section className="section" ref={studioRef} aria-label="GIF Studio">
          <h2 className="section-title">✂️ GIF Studio</h2>

          {!videoUrl ? (
            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                handleFile(e.dataTransfer.files?.[0]);
              }}
              onClick={() => document.getElementById("file-input")?.click()}
            >
              <p>🎥 Drop a video file here, or</p>
              <span className="btn btn-primary">Choose file</span>
              <input
                id="file-input"
                type="file"
                accept="video/*"
                style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </div>
          ) : (
            <>
              <video
                ref={trimVideoRef}
                className="preview"
                src={videoUrl}
                controls
                onLoadedMetadata={onVideoMetadata}
              />
              <p className="meta-line">
                📄 {fileName} · {formatSeconds(duration)} long
              </p>
              <button
                className="btn btn-secondary"
                style={{ marginTop: 8, padding: "8px 18px", minHeight: 40, fontSize: "0.9rem" }}
                onClick={() => {
                  if (videoUrl) URL.revokeObjectURL(videoUrl);
                  setVideoUrl(null);
                  setDuration(0);
                  setGifUrl(null);
                  setEstimateBytes(null);
                  setEffectiveSettings(null);
                  setTightenNote(null);
                  inputBlobRef.current = null;
                }}
              >
                Pick a different video
              </button>

              {duration > 0 && (
                <div className="trim-grid">
                  <label className="label">
                    Start: <strong>{trimStart.toFixed(1)}s</strong>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={trimStart}
                    onChange={(e) => {
                      const v = Math.min(parseFloat(e.target.value), trimEnd - 0.5);
                      setTrimStart(v);
                      // Scrub the preview to the exact in-frame while dragging.
                      const vid = trimVideoRef.current;
                      if (vid) {
                        vid.pause();
                        vid.currentTime = v;
                      }
                    }}
                  />
                  <label className="label">
                    End: <strong>{trimEnd.toFixed(1)}s</strong>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={trimEnd}
                    onChange={(e) => {
                      const v = Math.max(parseFloat(e.target.value), trimStart + 0.5);
                      setTrimEnd(v);
                      // Scrub the preview to the exact out-frame while dragging.
                      const vid = trimVideoRef.current;
                      if (vid) {
                        vid.pause();
                        vid.currentTime = v;
                      }
                    }}
                  />
                  <p className="meta-line">✂️ Clip length: {trimDur.toFixed(1)}s</p>
                </div>
              )}

              <label className="label">
                Frame rate: <strong>{settings.fps} fps</strong>
              </label>
              <input
                type="range"
                min={5}
                max={30}
                step={1}
                value={settings.fps}
                onChange={(e) => setSettings((s) => ({ ...s, fps: parseInt(e.target.value, 10) }))}
              />

              <label className="label">Width</label>
              <select
                className="select-input"
                value={settings.width}
                onChange={(e) => setSettings((s) => ({ ...s, width: parseInt(e.target.value, 10) }))}
              >
                {WIDTH_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {w}px
                  </option>
                ))}
              </select>

              <label className="label">Colors</label>
              <select
                className="select-input"
                value={settings.colors}
                onChange={(e) => setSettings((s) => ({ ...s, colors: parseInt(e.target.value, 10) }))}
              >
                {COLOR_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <div className="checkbox-row">
                <input
                  type="checkbox"
                  id="dither"
                  checked={settings.dither}
                  onChange={(e) => setSettings((s) => ({ ...s, dither: e.target.checked }))}
                />
                <label htmlFor="dither">Dithering (smoother gradients)</label>
              </div>

              <label className="label">
                Target size: <strong>{settings.targetMB} MB</strong>
              </label>
              <input
                type="range"
                min={1}
                max={25}
                step={1}
                value={settings.targetMB}
                onChange={(e) => setSettings((s) => ({ ...s, targetMB: parseInt(e.target.value, 10) }))}
              />

              {(estimating || engineLoading) && (
                <div className="progress-wrap">
                  <QuoteBar active={true} />
                  <div className="progress-track">
                    <div className="progress-fill progress-indeterminate" />
                  </div>
                  <p className="status-text">
                    {engineLoading ? "Loading video engine…" : "Estimating GIF size…"}
                  </p>
                </div>
              )}

              {!estimating && !engineLoading && estimateBytes !== null && (
                <div className="note" style={{ marginTop: 16 }}>
                  📏 Estimated ≈ <strong>{formatMB(estimateBytes)} MB</strong>
                </div>
              )}
              {tightenNote && !estimating && <div className="note">🔧 {tightenNote}</div>}

              <div className="btn-row">
                <button className="btn btn-primary" onClick={convert} disabled={converting || duration <= 0}>
                  {converting ? "Making your GIF…" : "🎞️ Make GIF"}
                </button>
              </div>

              {converting && (
                <div className="progress-wrap">
                  <QuoteBar active={true} />
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${Math.round(convertProgress * 100)}%` }} />
                  </div>
                  <p className="status-text">{Math.round(convertProgress * 100)}%</p>
                </div>
              )}

              {gifUrl && (
                <div className="gif-result">
                  <img src={gifUrl} alt="Your finished GIF" />
                  <div className="btn-row" style={{ justifyContent: "center" }}>
                    <a
                      className="btn btn-secondary"
                      href={gifUrl}
                      download={`${sanitizeFileName(fileName.replace(/\.[^.]+$/, ""))}.gif`}
                    >
                      ⬇️ Download GIF
                    </a>
                  </div>
                </div>
              )}

              {studioError && <div className="error-box">⚠️ {studioError}</div>}
            </>
          )}
        </section>

        {/* ================= FETCH CLIP ================= */}
        <section className="section" aria-label="Fetch Clip">
          <h2 className="section-title">📥 Fetch Clip</h2>
          <p className="meta-line">
            Paste a YouTube, TikTok, or public Instagram link and grab the clip straight
            from the source.
          </p>

          <label className="label" htmlFor="clip-url">
            Video URL
          </label>
          <input
            id="clip-url"
            className="text-input"
            type="url"
            inputMode="url"
            placeholder="https://www.youtube.com/watch?v=… or TikTok link"
            value={clipUrl}
            onChange={(e) => setClipUrl(e.target.value)}
          />

          <label className="label" htmlFor="clip-quality">
            Quality
          </label>
          <select
            id="clip-quality"
            className="select-input"
            value={clipQuality}
            onChange={(e) => setClipQuality(e.target.value as "360" | "720" | "1080")}
          >
            <option value="360">360p (small)</option>
            <option value="720">720p (balanced)</option>
            <option value="1080">1080p (sharp)</option>
          </select>

          <div className="checkbox-row">
            <input
              type="checkbox"
              id="clip-thumb"
              checked={clipThumb}
              onChange={(e) => setClipThumb(e.target.checked)}
            />
            <label htmlFor="clip-thumb">Also grab thumbnail</label>
          </div>

          <div className="btn-row">
            <button className="btn btn-primary" onClick={fetchClip} disabled={fetching || !clipUrl.trim()}>
              {fetching ? "Fetching…" : "📥 Fetch Clip"}
            </button>
            {fetching && (
              <button className="btn btn-secondary" onClick={() => { fetchCancelRef.current = true; }}>
                ✕ Cancel
              </button>
            )}
          </div>

          {fetching && (
            <div className="progress-wrap">
              <QuoteBar active={true} />
              <div className="progress-track">
                <div className="progress-fill progress-indeterminate" />
              </div>
              {fetchStatus && <p className="meta-line" style={{ marginTop: 8 }}>🔁 {fetchStatus}</p>}
            </div>
          )}

          {fetchError && <div className="error-box">⚠️ {fetchError}</div>}

          {fetchResult && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: "1.05rem" }}>{fetchResult.title}</h3>
              <p className="meta-line">
                ⏱️ {formatSeconds(fetchResult.durationSeconds)}
                {fetchResult.height ? ` · ${fetchResult.height}p` : ""}
                {fetchResult.note ? ` · ℹ️ ${fetchResult.note}` : ""}
              </p>
              {fetchResult.thumbnailUrl && (
                <img className="thumb" src={fetchResult.thumbnailUrl} alt="Video thumbnail" />
              )}
              <div className="btn-row">
                <a
                  className="btn btn-secondary"
                  href={fetchResult.downloadUrl}
                  download={`${sanitizeFileName(fetchResult.title)}.${fetchResult.ext ?? "mp4"}`}
                  target="_blank"
                  rel="noopener"
                >
                  ⬇️ Save Video
                </a>
                <button className="btn btn-primary" onClick={loadClipIntoTrimmer} disabled={loadingClip}>
                  {loadingClip ? "Loading…" : "✂️ Load into GIF Trimmer"}
                </button>
                {fetchResult.thumbnailUrl && (
                  <a
                    className="btn btn-secondary"
                    href={fetchResult.thumbnailUrl}
                    download={`${sanitizeFileName(fetchResult.title)}-thumbnail.jpg`}
                    target="_blank"
                    rel="noopener"
                  >
                    🖼️ Download thumbnail
                  </a>
                )}
              </div>
              {loadMsg && <div className="note">{loadMsg}</div>}
            </div>
          )}
        </section>

        {!busy && <QuoteBar active={false} />}
      </main>
    </div>
  );
}
