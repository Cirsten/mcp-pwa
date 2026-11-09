/* MCP Reading Order PWA - main thread.
 * Keeps a copy of the GitHub repo in IndexedDB (only changed files are downloaded, checked by git SHA),
 * hands the files to a Web Worker running Python (Pyodide), and returns the CSV results as a zip. */
"use strict";
const APP_VERSION = "1.4.0";
const $ = (s) => document.querySelector(s);
const MB = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
const fmtSize = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : MB(n));
const PROXY_UPLOAD_LIMIT = 3_000_000; // Vercel functions accept ~4.5 MB per request; base64 adds a third
const DEFAULT_SOURCES = "abcdefghijklmnopqrstuvwxyz".split("").map((l) => ["char", l, `https://chronologyproject.com/${l}.php`])
  .concat([["char", "key", "https://chronologyproject.com/key.php"]]);

/* ------------------------------------------------------------------ small helpers */
function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function show(el, on) { (typeof el === "string" ? $(el) : el).classList.toggle("hidden", !on); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gitBlobSha(buf) {
  const data = new Uint8Array(buf);
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head); all.set(data, head.length);
  const d = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textOf = (buf) => new TextDecoder().decode(buf);

/* ------------------------------------------------------------------ IndexedDB */
const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("mcp-pwa", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("files", { keyPath: "path" }); r.result.createObjectStore("kv"); };
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(store, key) { return this.tx(store, "readonly", (s) => s.get(key)); },
  put(store, val, key) { return this.tx(store, "readwrite", (s) => (key === undefined ? s.put(val) : s.put(val, key))); },
  del(store, key) { return this.tx(store, "readwrite", (s) => s.delete(key)); },
  all(store) { return this.tx(store, "readonly", (s) => s.getAll()); },
  clear(store) { return this.tx(store, "readwrite", (s) => s.clear()); },
};

/* ------------------------------------------------------------------ settings */
function loadCfg() {
  try { return JSON.parse(localStorage.getItem("mcp.cfg")) || {}; } catch (e) { return {}; }
}
function saveCfg(c) { try { localStorage.setItem("mcp.cfg", JSON.stringify(c)); } catch (e) { /* private mode */ } }
let cfg = Object.assign({ mode: "token", repo: "", branch: "main", subdir: "", token: "", pass: "" }, loadCfg());
const prefix = () => (cfg.subdir ? cfg.subdir.replace(/^\/+|\/+$/g, "") + "/" : "");
const configured = () => (cfg.mode === "proxy" ? Boolean(cfg.pass && cfg.repo) : Boolean(cfg.token && cfg.repo));

/* ------------------------------------------------------------------ GitHub client */
class GitHub {
  constructor(c) { this.c = c; }
  async api(method, path, { body, accept, raw } = {}) {
    let url, headers = { accept: accept || "application/vnd.github+json" };
    if (this.c.mode === "proxy") {
      url = "api/gh?p=" + encodeURIComponent(path);
      headers["x-app-passcode"] = this.c.pass;
    } else {
      url = "https://api.github.com" + path;
      headers.authorization = "Bearer " + this.c.token;
      headers["x-github-api-version"] = "2022-11-28";
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    if (!r.ok) {
      let msg = ""; try { const j = await r.json(); msg = j.message || j.error || ""; } catch (e) { /* not json */ }
      const hint = r.status === 401 ? " (token or passcode wrong / expired)" : r.status === 404 ? " (repo, branch or file not found - or the token cannot see this repo)" : r.status === 403 ? " (no permission or rate limit)" : "";
      const err = new Error(`GitHub ${r.status}${hint}${msg ? ": " + msg : ""}`); err.status = r.status; throw err;
    }
    return raw ? r.arrayBuffer() : r.status === 204 ? null : r.json();
  }
  get R() { return "/repos/" + this.c.repo; }
  branchInfo() { return this.api("GET", `${this.R}/branches/${encodeURIComponent(this.c.branch)}`); }
  async tree(ref) {
    const t = await this.api("GET", `${this.R}/git/trees/${ref}?recursive=1`);
    if (t.truncated) toast("Warning: the repository is very large and GitHub returned only part of the file list.", 8000);
    return t.tree;
  }
  async blob(sha, path, size) {
    if (this.c.mode !== "proxy" || size < PROXY_UPLOAD_LIMIT) {
      return this.api("GET", `${this.R}/git/blobs/${sha}`, { accept: "application/vnd.github.raw+json", raw: true });
    }
    // Big file through Vercel: ask GitHub for a short-lived download link and fetch it directly.
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const meta = await this.api("GET", `${this.R}/contents/${enc}?ref=${encodeURIComponent(this.c.branch)}`, { accept: "application/vnd.github.object+json" });
    const r = await fetch(meta.download_url, { cache: "no-store" });
    if (!r.ok) throw new Error(`download of ${path} failed: HTTP ${r.status}`);
    return r.arrayBuffer();
  }
  /** changes: [{path, data: ArrayBuffer | null (= delete)}] -> one commit; returns new commit sha */
  async commit(changes, message, onProgress = () => {}) {
    const ref = await this.api("GET", `${this.R}/git/ref/heads/${encodeURIComponent(this.c.branch)}`);
    const parent = ref.object.sha;
    const pc = await this.api("GET", `${this.R}/git/commits/${parent}`);
    const tree = [];
    let i = 0;
    for (const ch of changes) {
      onProgress(++i, changes.length, ch.path);
      if (ch.data === null) { tree.push({ path: ch.path, mode: "100644", type: "blob", sha: null }); continue; }
      if (this.c.mode === "proxy" && ch.data.byteLength > PROXY_UPLOAD_LIMIT) {
        throw new Error(`${ch.path} is ${MB(ch.data.byteLength)}: too big to send through Vercel. Upload it on github.com, or use "Token on this device".`);
      }
      const b = await this.api("POST", `${this.R}/git/blobs`, { body: { content: toBase64(ch.data), encoding: "base64" } });
      tree.push({ path: ch.path, mode: "100644", type: "blob", sha: b.sha });
    }
    const nt = await this.api("POST", `${this.R}/git/trees`, { body: { base_tree: pc.tree.sha, tree } });
    const nc = await this.api("POST", `${this.R}/git/commits`, { body: { message, tree: nt.sha, parents: [parent] } });
    await this.api("PATCH", `${this.R}/git/refs/heads/${encodeURIComponent(this.c.branch)}`, { body: { sha: nc.sha } });
    return nc.sha;
  }
}
const gh = () => new GitHub(cfg);

/* ------------------------------------------------------------------ local copy of the repo */
async function localFiles() { return (await idb.all("files")).sort((a, b) => a.path.localeCompare(b.path)); }

async function storeLocal(path, buf, sha) {
  await idb.put("files", { path, sha: sha || (await gitBlobSha(buf)), size: buf.byteLength, blob: new Blob([buf]), at: Date.now() });
}

async function syncRepo() {
  if (!configured()) throw new Error("Set up the GitHub connection first (Setup tab).");
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const g = gh();
  const br = await g.branchInfo();
  const pre = prefix();
  const remote = (await g.tree(br.commit.commit.tree.sha))
    .filter((t) => t.type === "blob" && t.path.startsWith(pre))
    .map((t) => ({ rel: t.path.slice(pre.length), path: t.path, sha: t.sha, size: t.size }))
    .filter((t) => t.size < 100 * 1048576);
  const local = new Map((await localFiles()).map((f) => [f.path, f]));
  const want = remote.filter((r) => !local.has(r.rel) || local.get(r.rel).sha !== r.sha);
  const gone = [...local.keys()].filter((p) => !remote.some((r) => r.rel === p));
  const total = want.reduce((s, r) => s + r.size, 0) || 1;
  let done = 0;
  const bar = $("#syncProgress div"); show("#syncProgress", want.length > 0);
  const log = [];
  for (const r of want) {
    $("#syncSummary").textContent = `Downloading ${r.rel} (${fmtSize(r.size)})…`;
    const buf = await g.blob(r.sha, r.path, r.size);
    const sha = await gitBlobSha(buf);
    if (sha !== r.sha) throw new Error(`${r.rel} changed on GitHub during the download - check again.`);
    log.push({ path: r.rel, what: local.has(r.rel) ? "updated" : "new", size: r.size });
    await storeLocal(r.rel, buf, sha);
    done += r.size; bar.style.width = Math.round((100 * done) / total) + "%";
  }
  for (const p of gone) { await idb.del("files", p); log.push({ path: p, what: "removed" }); }
  show("#syncProgress", false);
  const info = { when: Date.now(), commit: br.commit.sha, commitDate: br.commit.commit.committer.date,
    message: br.commit.commit.message.split("\n")[0], count: remote.length, changes: log };
  await idb.put("kv", info, "lastSync");
  return info;
}

/* ------------------------------------------------------------------ RUN tab: sync */
async function renderSync(info) {
  info = info || (await idb.get("kv", "lastSync"));
  const list = $("#syncChanges"); list.innerHTML = "";
  if (!info) { $("#syncSummary").textContent = configured() ? "Not synced yet." : "Not connected - open Setup."; return; }
  const when = new Date(info.when).toLocaleString();
  $("#syncSummary").innerHTML = `${info.count} files, checked ${esc(when)}. Latest change in the repo: ` +
    `<b>${esc(info.message)}</b> (${esc(new Date(info.commitDate).toLocaleDateString())}).` +
    (info.changes.length ? ` <span class="ok">${info.changes.length} file(s) updated on this device.</span>` : " Everything here was already up to date.");
  for (const c of info.changes.slice(0, 200)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="${c.what === "removed" ? "warn" : "ok"}">${c.what}</span> ${esc(c.path)}${c.size ? " · " + fmtSize(c.size) : ""}`;
    list.appendChild(li);
  }
}

async function doSync(btn) {
  if (btn) btn.disabled = true;
  try { const info = await syncRepo(); await renderSync(info); await renderFiles(); await renderDates(); return true; }
  catch (e) { $("#syncSummary").innerHTML = `<span class="bad">${esc(e.message)}</span>`; show("#syncProgress", false); return false; }
  finally { if (btn) btn.disabled = false; }
}

/* ------------------------------------------------------------------ GCD file */
let gcdHandle = null, gcdFile = null;
async function initGcd() {
  try { gcdHandle = (await idb.get("kv", "gcdHandle")) || null; } catch (e) { gcdHandle = null; }
  renderGcd();
}
function renderGcd() {
  const name = gcdFile ? gcdFile.name : gcdHandle ? gcdHandle.name : null;
  $("#gcdState").innerHTML = name
    ? `Using <b>${esc(name)}</b>${gcdFile ? " (" + (gcdFile.size / 1e9).toFixed(2) + " GB)" : " (remembered - access is confirmed when you run)"}.`
    : "No GCD file chosen.";
  show("#btnGcdForget", Boolean(name));
}
async function pickGcd() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ multiple: false, id: "gcd" });
      gcdHandle = h; gcdFile = null;
      try { await idb.put("kv", h, "gcdHandle"); } catch (e) { /* handle not storable */ }
      renderGcd();
    } catch (e) { if (e.name !== "AbortError") toast(e.message); }
  } else $("#gcdInput").click();
}
async function getGcdFile() {
  if (gcdFile) return gcdFile;
  if (!gcdHandle) return null;
  let p = await gcdHandle.queryPermission({ mode: "read" });
  if (p !== "granted") p = await gcdHandle.requestPermission({ mode: "read" });
  if (p !== "granted") { toast("No permission to read the GCD file - running without it."); return null; }
  return gcdHandle.getFile();
}

/* dates.csv lives in the repo under cache/ (shared between devices) and on this device; the newer wins */
async function chooseDatesCache() {
  const repoD = await idb.get("files", "cache/dates.csv");
  const repoS = await idb.get("files", "cache/pipeline_state.json");
  const local = await idb.get("kv", "localCache");
  const stamp = async (blob) => { try { return JSON.parse(await blob.text()).dates_generated_at || ""; } catch (e) { return ""; } };
  const repo = repoD ? { dates: repoD.blob, state: repoS ? repoS.blob : null, at: repoS ? await stamp(repoS.blob) : "", from: "repo" } : null;
  const loc = local && local.dates ? { dates: local.dates, state: local.state, at: local.state ? await stamp(local.state) : "", from: "this device" } : null;
  if (repo && loc) return loc.at > repo.at ? loc : repo;
  return repo || loc;
}
const stampOf = async (blob) => { try { return JSON.parse(await blob.text()).dates_generated_at || ""; } catch (e) { return ""; } };

/** true when this device holds GCD dates that the repo lacks or has an older copy of */
async function datesNeedUpload() {
  const local = await idb.get("kv", "localCache");
  if (!local || !local.dates) return false;
  const repoD = await idb.get("files", "cache/dates.csv");
  if (!repoD) return true;
  const repoS = await idb.get("files", "cache/pipeline_state.json");
  const la = local.state ? await stampOf(local.state) : "";
  const ra = repoS ? await stampOf(repoS.blob) : "";
  return Boolean(la) && la > ra;
}

async function saveDatesToRepo(datesBuf, stateBuf) {
  const changes = [{ path: prefix() + "cache/dates.csv", data: datesBuf }];
  if (stateBuf) changes.push({ path: prefix() + "cache/pipeline_state.json", data: stateBuf });
  await gh().commit(changes, "Update GCD dates cache (from the app)");
  for (const c of changes) await storeLocal(c.path.slice(prefix().length), c.data);
  await renderDates();
}

function retryButton(fn, label = "Try again") {
  const b = Object.assign(document.createElement("button"), { className: "link", textContent: label });
  b.onclick = () => { b.disabled = true; fn(); };
  return b;
}

async function renderDates() {
  const c = await chooseDatesCache();
  const el = $("#datesState");
  el.innerHTML = c
    ? `Saved dates: <b>${c.at ? esc(new Date(c.at).toLocaleString()) : "date unknown"}</b> (from ${c.from}).`
    : `<span class="warn">No dates.csv yet - for the best order, choose gcd.db for the first run.</span>`;
  if (configured() && (await datesNeedUpload())) {
    const local = await idb.get("kv", "localCache");
    el.insertAdjacentHTML("beforeend", ` <span class="warn">Not in the repo yet, so your other devices can't use them.</span> `);
    const save = async () => {
      try {
        await saveDatesToRepo(await local.dates.arrayBuffer(), local.state ? await local.state.arrayBuffer() : null);
        toast("GCD dates saved to the repo.");
      } catch (e) {
        toast("Could not save the dates: " + e.message, 8000);
        await renderDates();
      }
    };
    el.appendChild(retryButton(save, "Save to repo"));
  }
}

/* ------------------------------------------------------------------ the Python worker */
let worker = null, workerReady = null;
function startWorker() {
  if (worker) return workerReady;
  worker = new Worker("worker.js");
  workerReady = new Promise((res, rej) => {
    worker.addEventListener("message", function h(e) {
      if (e.data.type === "ready") { worker.removeEventListener("message", h); res(); }
      if (e.data.type === "error") { worker.removeEventListener("message", h); rej(new Error(e.data.message)); }
      if (e.data.type === "status") $("#runStatus").textContent = e.data.text;
    });
  });
  worker.postMessage({ type: "init" });
  return workerReady;
}
function killWorker() { if (worker) worker.terminate(); worker = null; workerReady = null; }

let running = false;
async function runPipeline() {
  if (running) return;
  running = true;
  const btn = $("#btnRun"); btn.disabled = true; show("#btnStop", true); show("#resultCard", false);
  const logEl = $("#log"); logEl.textContent = ""; show(logEl, true);
  const status = (t) => { $("#runStatus").textContent = t; };
  const addLog = (l) => { logEl.textContent += l + "\n"; if (logEl.scrollHeight - logEl.scrollTop < logEl.clientHeight + 120) logEl.scrollTop = logEl.scrollHeight; };
  try {
    // ask for the GCD file permission first, while the button click still counts as a user action
    let gcd = null;
    try { gcd = await getGcdFile(); } catch (e) { addLog("GCD file: " + e.message); }

    if ($("#optAutoSync").checked && configured()) {
      if (!navigator.onLine) addLog("Offline - using the files already on this device.");
      else {
        status("Checking GitHub for updated files…");
        const ok = await doSync(null);
        if (!ok) addLog("Could not check GitHub (" + $("#syncSummary").textContent + ") - using the files already on this device.");
      }
    }
    const stored = await localFiles();
    if (!stored.some((f) => f.path === "run_pipeline.py")) throw new Error("No run_pipeline.py on this device yet - connect to GitHub (Setup) and check for updates.");

    status("Preparing files…");
    const files = {}, transfer = [];
    for (const f of stored) {
      if (f.path.startsWith("cache/") || f.path.startsWith("outputs/")) continue;
      const buf = await f.blob.arrayBuffer(); files[f.path] = buf; transfer.push(buf);
    }
    const cache = await chooseDatesCache();
    if (cache) {
      const d = await cache.dates.arrayBuffer(); files["dates.csv"] = d; transfer.push(d);
      if (cache.state) { const s = await cache.state.arrayBuffer(); files[".pipeline_state.json"] = s; transfer.push(s); }
      addLog(`Using saved dates.csv from ${cache.from}.`);
    }
    const options = {
      forceDates: $("#optForceDates").checked, skipUniverses: $("#optSkipUniverses").checked,
      mergeArgs: $("#optMergeArgs").value.trim(),
    };
    await startWorker();
    const t0 = Date.now();
    const done = await new Promise((res, rej) => {
      const h = (e) => {
        const m = e.data;
        if (m.type === "log") addLog(m.line);
        else if (m.type === "status") status(m.text);
        else if (m.type === "done") { worker.removeEventListener("message", h); res(m); }
        else if (m.type === "error") { worker.removeEventListener("message", h); rej(new Error(m.message)); }
      };
      worker.addEventListener("message", h);
      runPipeline._reject = rej;
      worker.postMessage({ type: "run", files, gcd, options }, transfer);
    });
    await afterRun(done, Math.round((Date.now() - t0) / 1000), Boolean(gcd));
  } catch (e) {
    status(""); addLog("\n" + e.message);
    $("#runStatus").innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  } finally {
    running = false; btn.disabled = false; show("#btnStop", false); runPipeline._reject = null;
  }
}
function stopRun() {
  killWorker();
  if (runPipeline._reject) runPipeline._reject(new Error("Stopped."));
}

async function afterRun(m, secs, hadGcd) {
  const r = m.result;
  const zipBlob = new Blob([m.zip], { type: "application/zip" });
  await idb.put("kv", { name: m.zipName, blob: zipBlob, when: Date.now(), info: m.zipInfo, result: r }, "lastZip");
  await idb.del("kv", "lastParts"); // parts belong to the previous order
  // keep this run's dates on the device
  const blobOf = (b) => (b ? new Blob([b]) : null);
  if (m.cache["dates.csv"]) await idb.put("kv", { dates: blobOf(m.cache["dates.csv"]), state: blobOf(m.cache[".pipeline_state.json"]) }, "localCache");
  await renderResult();
  const ok = r.code === 0;
  $("#runStatus").innerHTML = ok ? `<span class="ok">Finished in ${secs}s.</span>` : `<span class="bad">The pipeline stopped with an error (code ${r.code}) - see the log. The zip still has whatever was produced.</span>`;

  const extra = $("#resultExtra"); extra.innerHTML = "";
  if (r.datesOld) extra.insertAdjacentHTML("beforeend", `<p class="warn small">The <b>gcd_series</b> and <b>gcd_year</b> columns (the matched GCD volume) are empty because the saved dates were made before they existed. Choose gcd.db and run once to fill them; after that every device gets them from the repo.</p>`);
  if (r.datesStale && !hadGcd) extra.insertAdjacentHTML("beforeend", `<p class="warn small">The comic list changed since the GCD dates were made, so some new comics have no cover date. Run again with gcd.db chosen to refresh them.</p>`);
  if (m.cache["dates.csv"] && configured() && (r.datesMade || (await datesNeedUpload()))) {
    // also when the dates were made earlier but never reached the repo (offline, option off, failed save)
    const p = document.createElement("p"); p.className = "small"; extra.appendChild(p);
    const save = async () => {
      p.textContent = "Saving the GCD dates to the repo…";
      try {
        await saveDatesToRepo(m.cache["dates.csv"], m.cache[".pipeline_state.json"]);
        p.innerHTML = `<span class="ok">GCD dates saved to the repo (cache/dates.csv) - your other devices will use them.</span>`;
      } catch (e) {
        p.innerHTML = `<span class="bad">Could not save the dates to the repo: ${esc(e.message)}</span> `;
        p.appendChild(retryButton(save));
      }
    };
    if ($("#optSaveCache").checked && navigator.onLine) await save();
    else {
      p.innerHTML = `These GCD dates are not in the repo yet, so your other devices can't use them. `;
      p.appendChild(retryButton(save, "Save to repo"));
    }
  }
  const changed = Object.entries(m.changed || {}).filter(([, v]) => v);
  if (changed.length && configured()) {
    const names = changed.map(([p]) => p).join(", ");
    const p = document.createElement("p"); p.className = "small";
    p.innerHTML = `The pipeline updated <b>${esc(names)}</b> (for example new typo suggestions in aliases.csv). `;
    const b = document.createElement("button"); b.textContent = "Save to repo"; b.className = "link";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await gh().commit(changed.map(([path, data]) => ({ path: prefix() + path, data })), `Update ${names} (from a pipeline run in the app)`);
        for (const [path, data] of changed) await storeLocal(path, data);
        b.replaceWith(Object.assign(document.createElement("span"), { className: "ok", textContent: "Saved." }));
      } catch (e) { b.disabled = false; toast(e.message, 8000); }
    };
    p.appendChild(b); extra.appendChild(p);
  }
}

async function renderResult() {
  const z = await idb.get("kv", "lastZip");
  if (!z) return;
  show("#resultCard", true);
  const files = (z.info && z.info.files) || [];
  $("#resultText").innerHTML = `<b>${esc(z.name)}</b> · ${fmtSize(z.blob.size)} · ${files.length} CSV files · made ${esc(new Date(z.when).toLocaleString())}` +
    (files.length ? `<br><span class="muted small">${esc(files.join(", "))}</span>` : "");
  const file = new File([z.blob], z.name, { type: "application/zip" });
  shareFiles.lastZip = file;
  show("#btnShare", canShareFile(file));
  const ok = !z.result || z.result.code === 0;
  show("#partsCard", ok && files.includes("reading_order.csv"));
  const uni = $("#partSource option[value=universes]");
  uni.disabled = !files.includes("reading_order_with_universes.csv");
  uni.textContent = "With alternate universes" + (uni.disabled ? " (not in the last run)" : "");
  if (uni.disabled && $("#partSource").value === "universes") $("#partSource").value = "main";
  $("#partSource option[value=scenes]").disabled = !files.includes("segment_flashback_order.csv");
  await renderParts();
}

/* ------------------------------------------------------------------ reading parts */
const PART_LABELS = { main: "main order", universes: "with alternate universes", scenes: "scenes" };
const partsSource = (p) => p.source || ((p.name.match(/^reading_parts_(main|universes|scenes)_/) || [])[1]) || "main";
const partsMode = (p) => p.mode || ((p.name.match(/_(lists|auto)_/) || [])[1]) || "lists";
const partsRepoPath = (source) => `outputs/reading_parts_${source}.zip`; // one file per kind; a new save replaces it

async function renderParts() {
  const p = await idb.get("kv", "lastParts");
  show("#partsResult", Boolean(p));
  if (!p) return;
  $("#partsStatus").innerHTML = `<b>${esc(p.name)}</b> · ${p.parts.length} parts · ${fmtSize(p.blob.size)} · made ${esc(new Date(p.when).toLocaleString())}`;
  const ul = $("#partsList"); ul.innerHTML = "";
  for (const n of p.parts) { const li = document.createElement("li"); li.textContent = n.replace(/\.xlsx$/, ""); ul.appendChild(li); }
  const file = new File([p.blob], p.name, { type: "application/zip" });
  shareFiles.lastParts = file;
  show("#btnPartsShare", canShareFile(file));
  show("#btnPartsGithub", configured());
  const rel = partsRepoPath(partsSource(p));
  const there = await idb.get("files", rel);
  const same = there && there.sha === (await gitBlobSha(await p.blob.arrayBuffer()));
  $("#btnPartsGithub").disabled = Boolean(same);
  $("#partsGithubState").innerHTML = same
    ? `<span class="ok">Saved on GitHub as <code>${esc(rel)}</code>.</span>`
    : there ? `<span class="muted">GitHub has an older <code>${esc(rel)}</code>; <b>Save to GitHub</b> replaces it.</span>`
      : `<span class="muted">Not on GitHub yet. <b>Save to GitHub</b> stores it as <code>${esc(rel)}</code>.</span>`;
}

async function savePartsToGithub() {
  const btn = $("#btnPartsGithub"); const st = $("#partsGithubState");
  const p = await idb.get("kv", "lastParts");
  if (!p || !configured()) return;
  btn.disabled = true;
  const source = partsSource(p), rel = partsRepoPath(source);
  st.textContent = `Saving to GitHub as ${rel}…`;
  try {
    const buf = await p.blob.arrayBuffer();
    const how = partsMode(p) === "auto" ? "cut automatically" : "cut at my reading lists";
    await gh().commit([{ path: prefix() + rel, data: buf }],
      `Save reading parts: ${PART_LABELS[source]}, ${how}, ${p.parts.length} parts (from the app)`);
    await storeLocal(rel, buf);
    await renderParts(); await renderFiles();
    toast(`Saved to GitHub as ${rel} (replaces the previous one).`);
  } catch (e) {
    st.innerHTML = `<span class="bad">Could not save to GitHub: ${esc(e.message)}</span>`;
    btn.disabled = false;
  }
}

async function makeParts() {
  if (running) return;
  running = true;
  const btn = $("#btnParts"); btn.disabled = true; $("#btnRun").disabled = true;
  const st = $("#partsStatus"); const lines = [];
  st.textContent = "Preparing…"; show("#partsResult", false);
  try {
    const z = await idb.get("kv", "lastZip");
    if (!z) throw new Error("Run the pipeline first.");
    const stored = await localFiles();
    const files = {}, transfer = [];
    for (const f of stored) {
      if (f.path.startsWith("cache/") || !(f.path.endsWith(".py") || /^(pre2017|post2017)\//.test(f.path) || f.path.endsWith(".csv"))) continue;
      const buf = await f.blob.arrayBuffer(); files[f.path] = buf; transfer.push(buf);
    }
    const results = await z.blob.arrayBuffer(); transfer.push(results);
    const options = { source: $("#partSource").value, mode: $("#partMode").value, size: Number($("#partSize").value) || 300 };
    await startWorker();
    const m = await new Promise((res, rej) => {
      const h = (e) => {
        const d = e.data;
        if (d.type === "log") { lines.push(d.line); st.textContent = d.line; }
        else if (d.type === "status") st.textContent = d.text;
        else if (d.type === "splitDone") { worker.removeEventListener("message", h); res(d); }
        else if (d.type === "error") { worker.removeEventListener("message", h); rej(new Error(d.message)); }
      };
      worker.addEventListener("message", h);
      runPipeline._reject = rej;
      worker.postMessage({ type: "split", files, results, options }, transfer);
    });
    if (m.result.code !== 0 || !m.zip) throw new Error(lines.slice(-6).join("\n") || "The split did not finish.");
    await idb.put("kv", { name: m.zipName, blob: new Blob([m.zip], { type: "application/zip" }), parts: m.result.parts, when: Date.now(),
      source: options.source, mode: options.mode }, "lastParts");
    await renderParts();
    const summary = lines.find((l) => / parts from /.test(l));
    if (summary) st.insertAdjacentHTML("beforeend", `<br><span class="ok">${esc(summary.replace(/ -> .*$/, ""))}</span>`);
  } catch (e) {
    st.innerHTML = `<span class="bad">${esc(e.message).replace(/\n/g, "<br>")}</span>`;
  } finally {
    running = false; btn.disabled = false; $("#btnRun").disabled = false; runPipeline._reject = null;
  }
}
async function downloadZip(key = "lastZip") {
  const z = await idb.get("kv", key); if (!z) return;
  const url = URL.createObjectURL(z.blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: z.name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// The files are kept ready so Share can start at once: an await before navigator.share() can use up the
// click's permission, and the browser then answers "Permission denied".
const shareFiles = {};
// Chrome and Edge on Windows refuse to share zip files, so the Share button is not offered there.
const onWindows = (navigator.userAgentData && navigator.userAgentData.platform === "Windows") || /Windows/i.test(navigator.userAgent);
const canShareFile = (file) => !onWindows && Boolean(navigator.canShare && navigator.canShare({ files: [file] }));
function shareZip(key = "lastZip") {
  const file = shareFiles[key];
  if (!file) return;
  const fallback = (why) => {
    downloadZip(key);
    toast(`${why} The zip was downloaded instead - attach it from your Downloads folder.`, 7000);
  };
  let p;
  try { p = navigator.share({ files: [file], title: file.name }); }
  catch (e) { fallback("This browser can't share this file."); return; }
  p.catch((e) => {
    if (e.name === "AbortError") return; // the person closed the share window
    fallback(e.name === "NotAllowedError" ? "This browser doesn't allow sharing zip files." : `Sharing failed (${e.message}).`);
  });
}

/* ------------------------------------------------------------------ FILES tab */
const GROUPS = [["char/", "Character pages (char/)"], ["universes/", "Universes"], ["pre2017/", "Reading lists - pre 2017"],
  ["post2017/", "Reading lists - 2017 on"], ["cache/", "Saved GCD dates (cache/)"], ["outputs/", "Saved reading parts (outputs/)"]];
async function renderFiles() {
  const files = await localFiles();
  const q = $("#fileFilter").value.trim().toLowerCase();
  const total = files.reduce((s, f) => s + f.size, 0);
  $("#filesSummary").textContent = files.length ? `${files.length} files, ${fmtSize(total)} on this device.` : "Nothing downloaded yet.";
  const box = $("#fileList"); box.innerHTML = "";
  const groups = new Map(GROUPS.map(([p, t]) => [p, { t, items: [] }]));
  groups.set("", { t: "Scripts and settings (top level)", items: [] }); groups.set("*", { t: "Other", items: [] });
  for (const f of files) {
    if (q && !f.path.toLowerCase().includes(q)) continue;
    const g = GROUPS.find(([p]) => f.path.startsWith(p));
    (g ? groups.get(g[0]) : f.path.includes("/") ? groups.get("*") : groups.get("")).items.push(f);
  }
  for (const [p, g] of groups) {
    if (!g.items.length) continue;
    box.insertAdjacentHTML("beforeend", `<h3>${esc(g.t)} · ${g.items.length}</h3>`);
    for (const f of g.items) {
      const row = document.createElement("div"); row.className = "frow";
      row.innerHTML = `<span class="name" title="${esc(f.path)}">${esc(p && p !== "*" ? f.path.slice(p.length) : f.path)}</span><span class="size">${fmtSize(f.size)}</span>`;
      const dl = Object.assign(document.createElement("button"), { className: "link", textContent: "Save", title: "Save a copy" });
      dl.onclick = () => { const u = URL.createObjectURL(f.blob); const a = Object.assign(document.createElement("a"), { href: u, download: f.path.split("/").pop() }); a.click(); setTimeout(() => URL.revokeObjectURL(u), 30000); };
      const del = Object.assign(document.createElement("button"), { className: "link", textContent: "Delete", title: "Delete from the repo" });
      del.onclick = () => deleteFromRepo(f.path);
      row.append(dl, del); box.appendChild(row);
    }
  }
}
async function deleteFromRepo(path) {
  if (!confirm(`Delete ${path} from the GitHub repo?\n(GitHub keeps history, so it can be recovered there.)`)) return;
  try { await gh().commit([{ path: prefix() + path, data: null }], `Delete ${path} (from the app)`); await idb.del("files", path); await renderFiles(); toast("Deleted " + path); }
  catch (e) { toast(e.message, 8000); }
}

let chosen = [];
async function upload() {
  const folder = $("#upFolder").value;
  if (!chosen.length) return;
  const st = $("#upState"); const btn = $("#btnUpload"); btn.disabled = true;
  try {
    const changes = [];
    for (const f of chosen) {
      const rel = (folder ? folder + "/" : "") + f.name;
      changes.push({ rel, path: prefix() + rel, data: await f.arrayBuffer() });
    }
    const local = new Map((await localFiles()).map((f) => [f.path, f.sha]));
    const real = [];
    for (const c of changes) if (local.get(c.rel) !== (await gitBlobSha(c.data))) real.push(c);
    if (!real.length) { st.textContent = "Those files are already in the repo, unchanged."; return; }
    const msg = $("#upMsg").value.trim() || `Upload ${real.map((c) => c.rel).join(", ")}`.slice(0, 200);
    await gh().commit(real, msg, (i, n, p) => { st.textContent = `Uploading ${i}/${n}: ${p}…`; });
    for (const c of real) await storeLocal(c.rel, c.data);
    st.innerHTML = `<span class="ok">Uploaded ${real.length} file(s) in one commit.</span>` + (real.length < changes.length ? ` ${changes.length - real.length} unchanged file(s) skipped.` : "");
    chosen = []; $("#upInput").value = ""; $("#upChosen").textContent = "No files chosen."; $("#upMsg").value = "";
    await renderFiles();
  } catch (e) { st.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  finally { btn.disabled = !chosen.length; }
}

/* sources.csv: folder,name,url - pages the app can re-download from the website */
async function loadSources() {
  const f = await idb.get("files", "sources.csv");
  if (!f) return DEFAULT_SOURCES;
  const rows = (await f.blob.text()).split(/\r?\n/).map((l) => l.split(",").map((s) => s.trim())).filter((r) => r.length >= 3 && r[2].startsWith("http"));
  return rows.length ? rows.map((r) => [r[0], r[1], r.slice(2).join(",")]) : DEFAULT_SOURCES;
}
async function renderSources() {
  const box = $("#srcList"); box.innerHTML = "";
  for (const [folder, name, url] of await loadSources()) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" data-folder="${esc(folder)}" data-name="${esc(name)}" data-url="${esc(url)}"><span>${esc(folder)}/${esc(name)}.html</span><span class="u">${esc(url)}</span>`;
    box.appendChild(l);
  }
}
async function fetchSelected() {
  const boxes = [...document.querySelectorAll("#srcList input:checked")];
  const st = $("#fetchState");
  if (!boxes.length) { st.textContent = "Tick the pages to fetch first."; return; }
  if (!configured()) { st.textContent = "Set up the GitHub connection first."; return; }
  const btn = $("#btnFetchSel"); btn.disabled = true;
  let changed = 0, same = 0; const errors = [];
  for (const [i, b] of boxes.entries()) {
    const path = `${b.dataset.folder}/${b.dataset.name}.html`;
    st.textContent = `Fetching ${i + 1}/${boxes.length}: ${path}…`;
    try {
      const headers = { "content-type": "application/json" };
      if (cfg.mode === "proxy") headers["x-app-passcode"] = cfg.pass; else headers["x-github-token"] = cfg.token;
      const r = await fetch("api/mcp-fetch", { method: "POST", headers, body: JSON.stringify({ url: b.dataset.url, path, repo: cfg.repo, branch: cfg.branch, subdir: cfg.subdir }) });
      if (r.status === 404) throw new Error("the app is not running on Vercel, so it cannot reach the website");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      j.changed ? changed++ : same++;
    } catch (e) { errors.push(`${path}: ${e.message}`); if (/not running on Vercel/.test(e.message)) break; }
    if (i < boxes.length - 1) await sleep(3000); // be gentle with the website
  }
  st.innerHTML = `${changed} changed and committed, ${same} unchanged.` + (errors.length ? `<br><span class="bad">${errors.map(esc).join("<br>")}</span>` : "");
  btn.disabled = false;
  if (changed) await doSync(null);
}

/* ------------------------------------------------------------------ SETUP tab */
function fillCfg() {
  document.querySelector(`input[name=mode][value=${cfg.mode}]`).checked = true;
  $("#cfgRepo").value = cfg.mode === "token" ? cfg.repo : ""; $("#cfgBranch").value = cfg.branch; $("#cfgSubdir").value = cfg.subdir;
  $("#cfgToken").value = cfg.token; $("#cfgPass").value = cfg.pass; modeUI();
}
function modeUI() {
  const m = document.querySelector("input[name=mode]:checked").value;
  show("#modeToken", m === "token"); show("#modeProxy", m === "proxy");
}
async function saveAndTest() {
  const m = document.querySelector("input[name=mode]:checked").value;
  const st = $("#cfgState"); st.textContent = "Testing…";
  const next = { ...cfg, mode: m };
  if (m === "token") {
    next.repo = $("#cfgRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
    next.branch = $("#cfgBranch").value.trim() || "main";
    next.subdir = $("#cfgSubdir").value.trim().replace(/^\/+|\/+$/g, "");
    next.token = $("#cfgToken").value.trim();
  } else {
    next.pass = $("#cfgPass").value;
    try {
      const r = await fetch("api/gh?info=1", { headers: { "x-app-passcode": next.pass }, cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 404 ? "No Vercel functions here - is the app deployed on Vercel?" : j.error || "HTTP " + r.status);
      Object.assign(next, { repo: j.repo, branch: j.branch, subdir: j.subdir || "" });
    } catch (e) { st.innerHTML = `<span class="bad">${esc(e.message)}</span>`; return; }
  }
  const switched = next.repo !== cfg.repo || next.subdir !== cfg.subdir || next.branch !== cfg.branch;
  try {
    const br = await new GitHub(next).branchInfo();
    cfg = next; saveCfg(cfg);
    if (switched) { await idb.clear("files"); await idb.del("kv", "lastSync"); }
    st.innerHTML = `<span class="ok">Connected to <b>${esc(cfg.repo)}</b> (${esc(cfg.branch)}). Latest change: ${esc(br.commit.commit.message.split("\n")[0])}</span>`;
    updateNet(); await renderSync(); await renderFiles(); await renderSources(); await renderDates();
  } catch (e) { st.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}
async function renderStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const e = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $("#storageState").textContent = `Using ${fmtSize(e.usage || 0)} of storage on this device${persisted ? " (protected from automatic clean-up)" : ""}.`;
}
function updateNet() {
  const p = $("#netState");
  p.textContent = !navigator.onLine ? "Offline" : configured() ? cfg.repo : "Not connected";
  p.className = "pill " + (!navigator.onLine ? "bad" : configured() ? "ok" : "");
}

/* ------------------------------------------------------------------ wiring */
function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tab").forEach((t) => show(t, t.id === "tab-" + name));
  if (name === "setup") renderStorage();
}
function wire() {
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
  $("#btnSync").onclick = (e) => doSync(e.currentTarget);
  $("#btnRun").onclick = runPipeline;
  $("#btnStop").onclick = stopRun;
  $("#btnGcd").onclick = pickGcd;
  $("#gcdInput").onchange = (e) => { gcdFile = e.target.files[0] || null; gcdHandle = null; renderGcd(); };
  $("#btnGcdForget").onclick = async () => { gcdFile = null; gcdHandle = null; $("#gcdInput").value = ""; await idb.del("kv", "gcdHandle"); renderGcd(); };
  $("#btnDownload").onclick = () => downloadZip("lastZip");
  $("#btnShare").onclick = () => shareZip("lastZip");
  $("#btnParts").onclick = makeParts;
  $("#btnPartsDownload").onclick = () => downloadZip("lastParts");
  $("#btnPartsShare").onclick = () => shareZip("lastParts");
  $("#btnPartsGithub").onclick = savePartsToGithub;
  $("#partMode").onchange = () => show("#partSizeWrap", $("#partMode").value === "auto");
  $("#btnPick").onclick = () => $("#upInput").click();
  $("#upInput").onchange = (e) => {
    chosen = [...e.target.files];
    $("#upChosen").textContent = chosen.length ? chosen.map((f) => `${f.name} (${fmtSize(f.size)})`).join(", ") : "No files chosen.";
    $("#btnUpload").disabled = !chosen.length;
  };
  $("#btnUpload").onclick = upload;
  $("#fileFilter").oninput = renderFiles;
  $("#btnFetchSel").onclick = fetchSelected;
  $("#btnSelAll").onclick = () => document.querySelectorAll("#srcList input").forEach((c) => (c.checked = true));
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.onchange = modeUI));
  $("#btnSave").onclick = saveAndTest;
  $("#btnPrep").onclick = async (e) => {
    e.currentTarget.disabled = true; toast("Downloading Python…");
    try { await startWorker(); toast("Python is ready and saved for offline use."); renderStorage(); }
    catch (err) { toast(err.message, 8000); killWorker(); }
    finally { e.currentTarget.disabled = false; }
  };
  $("#btnClear").onclick = async () => {
    if (!confirm("Delete the downloaded repo files, saved dates and last result from this device? (Nothing on GitHub is touched.)")) return;
    await idb.clear("files"); await idb.clear("kv"); gcdHandle = null; renderGcd();
    await renderSync(); await renderFiles(); await renderDates(); show("#resultCard", false); renderStorage(); toast("Cleared.");
  };
  for (const id of ["optAutoSync", "optSaveCache", "optSkipUniverses"]) {
    const el = $("#" + id);
    try { const v = localStorage.getItem("mcp.opt." + id); if (v !== null) el.checked = v === "1"; } catch (e) { /* ignore */ }
    el.onchange = () => { try { localStorage.setItem("mcp.opt." + id, el.checked ? "1" : "0"); } catch (e) { /* ignore */ } };
  }
  window.addEventListener("online", updateNet); window.addEventListener("offline", updateNet);
}

/* ------------------------------------------------------------------ install as an app */
let installPrompt = null;
const isInstalled = () => matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches || navigator.standalone === true;
function renderInstall() {
  const installed = isInstalled();
  show("#btnInstall", Boolean(installPrompt) && !installed);
  $("#installState").innerHTML = installed
    ? `<span class="ok">Installed: you are using the app version.</span>`
    : installPrompt ? `Not installed yet. Press <b>Install app</b> at the top.`
      : `Not installed in this window (or already installed - then open it from your Start menu / home screen).`;
  show("#installHelp", !installed);
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; renderInstall(); });
window.addEventListener("appinstalled", () => { installPrompt = null; renderInstall(); toast("Installed. Open MCP Reading Order from your Start menu or home screen."); });

async function main() {
  wire(); fillCfg(); updateNet(); renderInstall();
  $("#btnInstall").onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") installPrompt = null;
    renderInstall();
  };
  const wanted = new URLSearchParams(location.search).get("tab");
  if (!configured()) selectTab("setup");
  else if (["run", "files", "setup"].includes(wanted)) selectTab(wanted);
  $("#appVersion").textContent = `App version ${APP_VERSION} · Python 3.12 (Pyodide 0.27.7)`;
  await Promise.all([renderSync(), renderFiles(), renderSources(), initGcd(), renderResult(), renderDates()]);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
main();
