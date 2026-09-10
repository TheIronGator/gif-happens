/**
 * public/ffmpeg-core/wrapper.js
 *
 * Static wrapper around the ffmpeg core-st module, loaded by the
 * @ffmpeg/ffmpeg worker instead of ffmpeg-core.js directly.
 *
 * Why: @ffmpeg/ffmpeg@0.12.x boots the core with a `mainScriptUrlOrBlob`
 * option that only ffmpeg-core 0.12.x understands. The single-threaded
 * core-st@0.11.1 ignores it and would resolve ffmpeg-core.wasm relative to
 * the worker chunk URL (404). This wrapper injects a `locateFile` so the
 * wasm is fetched from this same directory instead.
 *
 * Served as a static file (same origin as the app). The core js/wasm next
 * to it are downloaded at build time by scripts/fetch-ffmpeg-core.mjs.
 */

const BASE = new URL(".", import.meta.url).href;
const real = await import(new URL("./ffmpeg-core.js", BASE).href);
const createFFmpegCore = real.default;

export default (opts = {}) =>
  createFFmpegCore({
    ...opts,
    locateFile: (path) =>
      typeof path === "string" && path.endsWith(".wasm")
        ? new URL("./ffmpeg-core.wasm", BASE).href
        : path,
  });
