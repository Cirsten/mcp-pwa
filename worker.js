/* Web Worker: owns the Python interpreter (Pyodide) so the page stays responsive during a long run. */
/* global importScripts, loadPyodide */
const BASE = self.location.href.replace(/[^/]*$/, "");
const WHEELS = [
  "networkx-3.4.2-py3-none-any.whl",
  "soupsieve-2.5-py3-none-any.whl",
  "beautifulsoup4-4.12.3-py3-none-any.whl",
  "sqlite3-1.0.0-cp312-cp312-pyodide_2024_0_wasm32.whl",
];

let py = null;
let logLines = [];

function post(type, data = {}) { self.postMessage({ type, ...data }); }
function log(line) { logLines.push(line); post("log", { line }); }

async function init() {
  if (py) return py;
  post("status", { text: "Starting Python (first time takes a little while)…" });
  importScripts(BASE + "vendor/pyodide/pyodide.js");
  py = await loadPyodide({ indexURL: BASE + "vendor/pyodide/" });
  py.setStdout({ batched: log });
  py.setStderr({ batched: log });
  post("status", { text: "Loading networkx, BeautifulSoup and sqlite3…" });
  await py.loadPackage(WHEELS.map((w) => BASE + "vendor/wheels/" + w), { messageCallback: () => {} });
  const runner = await (await fetch(BASE + "runner.py", { cache: "no-cache" })).text();
  py.FS.mkdirTree("/app");
  py.FS.writeFile("/app/pwa_runner.py", runner);
  py.runPython("import sys; sys.path.insert(0, '/app'); import pwa_runner");
  return py;
}

function rmTree(FS, dir) {
  if (!FS.analyzePath(dir).exists) return;
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const p = dir + "/" + name;
    if (FS.isDir(FS.stat(p).mode)) { rmTree(FS, p); FS.rmdir(p); } else FS.unlink(p);
  }
}

function writeWork(files) {
  const FS = py.FS;
  rmTree(FS, "/work");
  FS.mkdirTree("/work");
  post("status", { text: `Copying ${Object.keys(files).length} files into the Python workspace…` });
  for (const [path, buf] of Object.entries(files)) {
    const dir = "/work/" + path.split("/").slice(0, -1).join("/");
    if (dir !== "/work/") FS.mkdirTree(dir);
    FS.writeFile("/work/" + path, new Uint8Array(buf));
  }
}

async function split({ files, results, options }) {
  logLines = [];
  await init();
  writeWork(files);
  py.FS.writeFile("/tmp/last_results.zip", new Uint8Array(results));
  post("status", { text: "Cutting the reading order into parts…" });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  const zipName = `reading_parts_${options.source}_${options.mode}_${stamp}.zip`;
  const result = JSON.parse(py.globals.get("pwa_runner").split(JSON.stringify({ ...options, zipName })));
  let zip = null;
  if (result.code === 0 && py.FS.analyzePath("/tmp/" + zipName).exists) {
    zip = py.FS.readFile("/tmp/" + zipName).buffer;
    py.FS.unlink("/tmp/" + zipName);
  }
  py.FS.unlink("/tmp/last_results.zip");
  self.postMessage({ type: "splitDone", result, zip, zipName }, zip ? [zip] : []);
}

async function run({ files, gcd, options }) {
  logLines = [];
  await init();
  const FS = py.FS;
  writeWork(files);
  let db = null;
  if (gcd) {
    // WORKERFS reads the file lazily, slice by slice: the 6 GB GCD file is never loaded into memory.
    FS.mkdirTree("/gcd");
    try { FS.unmount("/gcd"); } catch (e) { /* not mounted */ }
    const file = new File([gcd], "gcd.db"); // plain name: no spaces or '?' in the sqlite URI
    FS.mount(FS.filesystems.WORKERFS, { files: [file] }, "/gcd");
    db = "/gcd/gcd.db";
    log(`GCD database attached: ${gcd.name} (${(gcd.size / 1e9).toFixed(2)} GB)`);
  }
  post("status", { text: "Running the pipeline…" });
  const runFn = py.globals.get("pwa_runner").run;
  const result = JSON.parse(runFn(JSON.stringify({ ...options, db })));
  if (gcd) { try { FS.unmount("/gcd"); } catch (e) { /* ignore */ } }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  const zipName = `mcp_output_${stamp}.zip`;
  const zipInfo = JSON.parse(py.globals.get("pwa_runner").make_zip(logLines.join("\n"), zipName));
  const zip = FS.readFile("/tmp/" + zipName).buffer;
  FS.unlink("/tmp/" + zipName);

  const read = (p) => (FS.analyzePath("/work/" + p).exists ? FS.readFile("/work/" + p).buffer : null);
  const cache = { "dates.csv": read("dates.csv"), ".pipeline_state.json": read(".pipeline_state.json") };
  const changed = {};
  for (const p of result.changedInputs || []) changed[p] = read(p);
  const transfer = [zip, ...Object.values(cache), ...Object.values(changed)].filter(Boolean);
  self.postMessage({ type: "done", result, zip, zipName, zipInfo, cache, changed }, transfer);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") { await init(); post("ready"); }
    else if (msg.type === "run") await run(msg);
    else if (msg.type === "split") await split(msg);
  } catch (err) {
    post("error", { message: String(err && err.message ? err.message : err) });
  }
};
