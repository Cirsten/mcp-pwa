// Re-download one page from chronologyproject.com and commit it to the repo if it changed.
// The browser cannot fetch that site itself (no CORS), and the page never has to pass back through the
// browser, so large pages are fine.
//   POST /api/mcp-fetch  { url, path }      path = repo path relative to the data folder, e.g. "char/a.html"
// Auth: x-app-passcode (server token) or x-github-token + body { repo: "owner/name", branch, subdir }.
const crypto = require("crypto");
const { cfg, passcodeOk, send, readBody, gh } = require("./_lib/common");

const UA = "mcp-personal-archiver/0.1 (personal research; slow, cached, one pass)";

async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: "bad JSON" }); }

  let token, repo, branch, subdir;
  if (req.headers["x-github-token"]) {
    token = String(req.headers["x-github-token"]);
    repo = String(body.repo || ""); branch = String(body.branch || "main");
    subdir = String(body.subdir || "").replace(/^\/+|\/+$/g, "");
  } else if (passcodeOk(req)) {
    ({ token, repo, branch, subdir } = cfg());
  } else {
    return send(res, 401, { error: "Wrong passcode or no token." });
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return send(res, 400, { error: "bad repo" });

  let url;
  try { url = new URL(String(body.url)); } catch (e) { return send(res, 400, { error: "bad url" }); }
  if (url.protocol !== "https:" || !/^(www\.)?chronologyproject\.com$/i.test(url.hostname)) {
    return send(res, 400, { error: "Only https://chronologyproject.com pages can be fetched." });
  }
  const rel = String(body.path || "");
  if (!/^(char|universes)\/[^/]+$/.test(rel) || rel.includes("..")) {
    return send(res, 400, { error: "path must be char/<name> or universes/<name>" });
  }
  const path = (subdir ? subdir + "/" : "") + rel;

  const page = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  const data = Buffer.from(await page.arrayBuffer());
  const head = data.subarray(0, 4000).toString("latin1").toLowerCase();
  if (!page.ok) return send(res, 502, { error: `The website answered HTTP ${page.status}.` });
  if (data.length < 2000 || head.includes("just a moment") || head.includes("cf-chl") || !head.includes("<html")) {
    return send(res, 502, { error: "The website did not return a normal page (blocked or a challenge page). Save it from your browser instead." });
  }

  const blobSha = crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  const enc = path.split("/").map(encodeURIComponent).join("/");
  const cur = await gh(token, `/repos/${repo}/contents/${enc}?ref=${encodeURIComponent(branch)}`, {
    headers: { accept: "application/vnd.github.object+json" },
  });
  let oldSha = null;
  if (cur.status === 200) oldSha = (await cur.json()).sha;
  else if (cur.status !== 404) return send(res, cur.status, { error: `GitHub: ${await cur.text()}` });
  if (oldSha === blobSha) return send(res, 200, { changed: false, size: data.length, sha: blobSha });

  const put = await gh(token, `/repos/${repo}/contents/${enc}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: `Refresh ${rel} from ${url.href}`,
      content: data.toString("base64"),
      branch,
      ...(oldSha ? { sha: oldSha } : {}),
    }),
  });
  if (!put.ok) return send(res, put.status, { error: `GitHub: ${await put.text()}` });
  return send(res, 200, { changed: true, size: data.length, sha: blobSha, created: !oldSha });
}

module.exports = async (req, res) => {
  try {
    await handler(req, res);
  } catch (e) {
    const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : "";
    send(res, 502, { error: `Could not reach the ${e && /chronologyproject/.test(String(e.cause && e.cause.hostname)) ? "website" : "server"}: ${e.message}${cause}` });
  }
};
