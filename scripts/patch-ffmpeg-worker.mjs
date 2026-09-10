#!/usr/bin/env node
/**
 * scripts/patch-ffmpeg-worker.mjs
 *
 * @ffmpeg/ffmpeg's ESM worker boots the core with:
 *     self.createFFmpegCore = (await import(_coreURL)).default;
 * Webpack rewrites that dynamic import and fails at runtime on blob:/https:
 * URLs with "Cannot find module". Adding `webpackIgnore: true` keeps it a
 * native dynamic import, which is what the ffmpeg loader needs.
 *
 * Runs during the Vercel build after `npm install` (see vercel.json), before
 * `next build`. Idempotent. Fails loudly if the expected pattern is missing
 * so the build breaks instead of shipping a silently broken worker.
 *
 * Usage: node scripts/patch-ffmpeg-worker.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workerPath = join(
  repoRoot,
  "node_modules",
  "@ffmpeg",
  "ffmpeg",
  "dist",
  "esm",
  "worker.js"
);

const NEEDLE = "/* @vite-ignore */ _coreURL";
const PATCHED_NEEDLE = "/* @vite-ignore */ /* webpackIgnore: true */ _coreURL";

function log(msg) {
  console.log(`[patch-ffmpeg-worker] ${msg}`);
}

function fail(msg) {
  console.error(`[patch-ffmpeg-worker] ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  let src;
  try {
    src = await readFile(workerPath, "utf8");
  } catch (err) {
    fail(`cannot read ${workerPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (src.includes("webpackIgnore: true")) {
    log("worker already patched, nothing to do");
    return;
  }
  if (!src.includes(NEEDLE)) {
    fail(
      `expected import pattern not found in ${workerPath} — @ffmpeg/ffmpeg may have changed; refusing to guess`
    );
  }
  src = src.replace(NEEDLE, PATCHED_NEEDLE);
  await writeFile(workerPath, src);
  log("patched worker.js dynamic import with webpackIgnore: true");
}

main().catch((err) => fail(err instanceof Error ? err.stack || err.message : String(err)));
