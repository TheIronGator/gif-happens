#!/usr/bin/env node
/**
 * scripts/fetch-ffmpeg-core.mjs
 *
 * Downloads the @ffmpeg/core-st build (ffmpeg-core.js + ffmpeg-core.wasm) at
 * BUILD time into <repoRoot>/public/ffmpeg-core/. Served same-origin by
 * Next.js, so the browser never depends on a third-party CDN at runtime.
 * Runs during the Vercel build (see vercel.json). NEVER runs at request time.
 *
 * The downloaded files are gitignored; only wrapper.js (hand-written, in this
 * directory) is committed.
 *
 * Usage: node scripts/fetch-ffmpeg-core.mjs
 */

import { mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.11.1";
const BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@${VERSION}/dist`;
const FILES = [
  { name: "ffmpeg-core.js", minBytes: 10 * 1024 },
  { name: "ffmpeg-core.wasm", minBytes: 5 * 1024 * 1024 },
];

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, "public", "ffmpeg-core");

function log(msg) {
  console.log(`[fetch-ffmpeg-core] ${msg}`);
}

function fail(msg) {
  console.error(`[fetch-ffmpeg-core] ERROR: ${msg}`);
  process.exit(1);
}

function main() {
  mkdirSync(outDir, { recursive: true });
  for (const { name, minBytes } of FILES) {
    const url = `${BASE}/${name}`;
    const dest = join(outDir, name);
    log(`downloading ${url}`);
    try {
      execFileSync(
        "curl",
        ["--fail", "--silent", "--show-error", "--location", "--retry", "3", "--max-time", "300", "-o", dest, url],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
    } catch (err) {
      const stderr = err.stderr ? String(err.stderr).trim() : err.message;
      fail(`curl download failed for ${name}: ${stderr}`);
    }
    const size = statSync(dest).size;
    if (size < minBytes) {
      fail(`${name} is suspiciously small (${size} bytes, expected > ${minBytes})`);
    }
    log(`wrote public/ffmpeg-core/${name} (${size} bytes)`);
  }
  log("ffmpeg-core ready");
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.stack || err.message : String(err));
}
