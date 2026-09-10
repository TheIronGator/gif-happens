/**
 * public/ffmpeg-core/worker.js
 *
 * Static ffmpeg.wasm class-worker (ES module), served as-is from public/.
 *
 * It replicates the @ffmpeg/ffmpeg worker message protocol (LOAD / EXEC /
 * FFPROBE / file ops / LOG / PROGRESS), but loads the core with a plain
 * native dynamic import instead of the importScripts-then-import fallback in
 * the bundled worker. The bundler rewrites that fallback import into a chunk
 * lookup that fails at runtime ("Cannot find module"), and build caches can
 * even resurrect the broken version — so this file is never bundled at all.
 * The import below stays native, and the engine boots.
 *
 * The core is @ffmpeg/core (single-threaded ESM build, self-hosted next to
 * this file). It understands the mainScriptUrlOrBlob option, so the wasm and
 * worker URLs ride along in the core URL hash, exactly like the stock worker.
 *
 * Used via:
 *   ffmpeg.load({
 *     classWorkerURL: "<origin>/ffmpeg-core/worker.js",
 *     coreURL: "/ffmpeg-core/ffmpeg-core.js",
 *     wasmURL: "/ffmpeg-core/ffmpeg-core.wasm",
 *   })
 */

const FFMessageType = {
  LOAD: "LOAD",
  EXEC: "EXEC",
  FFPROBE: "FFPROBE",
  WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE",
  RENAME: "RENAME",
  CREATE_DIR: "CREATE_DIR",
  LIST_DIR: "LIST_DIR",
  DELETE_DIR: "DELETE_DIR",
  MOUNT: "MOUNT",
  UNMOUNT: "UNMOUNT",
  ERROR: "ERROR",
  DOWNLOAD: "DOWNLOAD",
  PROGRESS: "PROGRESS",
  LOG: "LOG",
};

const ERROR_UNKNOWN_MESSAGE_TYPE = new Error("unknown message type");
const ERROR_NOT_LOADED = new Error(
  "ffmpeg is not loaded, call `await ffmpeg.load()` first"
);
const ERROR_IMPORT_FAILURE = new Error("failed to import ffmpeg-core.js");

let ffmpeg;

const load = async ({ coreURL, wasmURL, workerURL }) => {
  const first = !ffmpeg;
  if (!coreURL) throw ERROR_IMPORT_FAILURE;
  // Native dynamic import. This file is served statically and never bundled,
  // so no bundler can rewrite this into a broken module lookup.
  const { default: createFFmpegCore } = await import(coreURL);
  if (typeof createFFmpegCore !== "function") throw ERROR_IMPORT_FAILURE;
  const _coreURL = coreURL;
  const _wasmURL = wasmURL ? wasmURL : coreURL.replace(/.js$/g, ".wasm");
  const _workerURL = workerURL ? workerURL : coreURL.replace(/.js$/g, ".worker.js");
  ffmpeg = await createFFmpegCore({
    // Encoded wasmURL and workerURL in the URL as a hack to fix locateFile
    // issue (same shape the stock worker sends; @ffmpeg/core understands it).
    mainScriptUrlOrBlob: `${_coreURL}#${btoa(
      JSON.stringify({ wasmURL: _wasmURL, workerURL: _workerURL })
    )}`,
  });
  ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
  ffmpeg.setProgress((data) =>
    self.postMessage({ type: FFMessageType.PROGRESS, data })
  );
  return first;
};

const exec = ({ args, timeout = -1 }) => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const ffprobe = ({ args, timeout = -1 }) => {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const writeFile = ({ path, data }) => {
  ffmpeg.FS.writeFile(path, data);
  return true;
};

const readFile = ({ path, encoding }) => ffmpeg.FS.readFile(path, { encoding });

const deleteFile = ({ path }) => {
  ffmpeg.FS.unlink(path);
  return true;
};

const rename = ({ oldPath, newPath }) => {
  ffmpeg.FS.rename(oldPath, newPath);
  return true;
};

const createDir = ({ path }) => {
  ffmpeg.FS.mkdir(path);
  return true;
};

const listDir = ({ path }) => {
  const names = ffmpeg.FS.readdir(path);
  const nodes = [];
  for (const name of names) {
    const stat = ffmpeg.FS.stat(`${path}/${name}`);
    const isDir = ffmpeg.FS.isDir(stat.mode);
    nodes.push({ name, isDir });
  }
  return nodes;
};

const deleteDir = ({ path }) => {
  ffmpeg.FS.rmdir(path);
  return true;
};

const mount = ({ fsType, options, mountPoint }) => {
  const fs = ffmpeg.FS.filesystems[fsType];
  if (!fs) return false;
  ffmpeg.FS.mount(fs, options, mountPoint);
  return true;
};

const unmount = ({ mountPoint }) => {
  ffmpeg.FS.unmount(mountPoint);
  return true;
};

self.onmessage = async ({
  data: { id, type, data: _data },
}) => {
  const trans = [];
  let data;
  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) throw ERROR_NOT_LOADED;
    switch (type) {
      case FFMessageType.LOAD:
        data = await load(_data);
        break;
      case FFMessageType.EXEC:
        data = exec(_data);
        break;
      case FFMessageType.FFPROBE:
        data = ffprobe(_data);
        break;
      case FFMessageType.WRITE_FILE:
        data = writeFile(_data);
        break;
      case FFMessageType.READ_FILE:
        data = readFile(_data);
        break;
      case FFMessageType.DELETE_FILE:
        data = deleteFile(_data);
        break;
      case FFMessageType.RENAME:
        data = rename(_data);
        break;
      case FFMessageType.CREATE_DIR:
        data = createDir(_data);
        break;
      case FFMessageType.LIST_DIR:
        data = listDir(_data);
        break;
      case FFMessageType.DELETE_DIR:
        data = deleteDir(_data);
        break;
      case FFMessageType.MOUNT:
        data = mount(_data);
        break;
      case FFMessageType.UNMOUNT:
        data = unmount(_data);
        break;
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (e) {
    self.postMessage({
      id,
      type: FFMessageType.ERROR,
      data: e.toString(),
    });
    return;
  }
  if (data instanceof Uint8Array) {
    trans.push(data.buffer);
  }
  self.postMessage({ id, type, data }, trans);
};
