/** @type {import('next').NextConfig} */
const nextConfig = {
  // Single-threaded ffmpeg.wasm (@ffmpeg/core-st) is used client-side, so no
  // COOP/COEP headers are required.
};

export default nextConfig;
