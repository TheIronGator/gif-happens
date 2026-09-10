#!/usr/bin/env node
/**
 * scripts/fetch-ytdlp.mjs
 *
 * Downloads the yt-dlp standalone Linux binary at BUILD time and places it at
 * <repoRoot>/bin/yt-dlp. Runs during the Vercel build (see vercel.json).
 * NEVER runs at request time.
 *
 * Usage: node scripts/fetch-ytdlp.mjs
 *
 * Idempotent: if bin/yt-dlp already exists and reports the pinned version,
 * it exits 0 immediately. Any failure exits 1 with a clear stderr message so
 * the build fails loudly.
 */

import { createWriteStream, chmodSync, existsSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import https from "https";

const VERSION = "2026.08.19";
const DOWNLOAD_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp_linux`;
const MIN_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB sanity floor
const MAX_REDIRECTS = 5;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(repoRoot, "bin");
const dest = join(binDir, "yt-dlp");

function log(msg) {
  console.log(`[fetch-ytdlp] ${msg}`);
}

function fail(msg) {
  console.error(`[fetch-ytdlp] ERROR: ${msg}`);
  process.exit(1);
}

/** Run the bundled binary with --version; return stdout or null. */
function binaryVersion(bin) {
  try {
    const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000 });
    if (res.error) return null;
    return (res.stdout || "").trim();
  } catch {
    return null;
  }
}

/** HTTPS GET that follows up to MAX_REDIRECTS redirects, resolves response. */
function fetchWithRedirects(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      reject(new Error("Too many redirects while downloading yt-dlp"));
      return;
    }
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res;
      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        // Drain the redirect body, then follow.
        res.resume();
        const next = new URL(headers.location, url).toString();
        log(`redirect -> ${next}`);
        resolve(fetchWithRedirects(next, redirectsLeft - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${statusCode} for ${url}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error("Download timed out"));
    });
  });
}

async function downloadBinary() {
  log(`downloading yt-dlp ${VERSION}`);
  log(`from ${DOWNLOAD_URL}`);
  const res = await fetchWithRedirects(DOWNLOAD_URL);
  await new Promise((resolve, reject) => {
    const file = createWriteStream(dest, { mode: 0o755 });
    res.pipe(file);
    res.on("error", (err) => {
      file.destroy();
      reject(err);
    });
    file.on("finish", resolve);
    file.on("error", reject);
  });
  chmodSync(dest, 0o755);
}

async function main() {
  if (existsSync(dest)) {
    const v = binaryVersion(dest);
    if (v && v.includes(VERSION)) {
      log(`yt-dlp already present (${v})`);
      return;
    }
    log(
      `existing bin/yt-dlp is missing or wrong version (got ${JSON.stringify(v)}), re-downloading`
    );
  }

  await mkdir(binDir, { recursive: true });

  try {
    await downloadBinary();
  } catch (err) {
    fail(`download failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const size = statSync(dest).size;
  if (size <= MIN_SIZE_BYTES) {
    fail(
      `downloaded binary is suspiciously small (${size} bytes, expected > ${MIN_SIZE_BYTES}). Aborting.`
    );
  }

  const v = binaryVersion(dest);
  if (!v || !v.includes(VERSION)) {
    fail(
      `version check failed: expected ${VERSION} in --version output, got ${JSON.stringify(v)}`
    );
  }

  log(`yt-dlp ${VERSION} ready at bin/yt-dlp (${size} bytes)`);
}

main().catch((err) => fail(err instanceof Error ? err.stack || err.message : String(err)));
