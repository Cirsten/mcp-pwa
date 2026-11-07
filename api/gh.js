// GitHub proxy: lets the app use a token kept in Vercel's environment variables instead of on the device.
//   GET  /api/gh?info=1                 -> { repo, branch, subdir } (passcode required)
//   ANY  /api/gh?p=/repos/<owner>/<repo>/...   -> forwarded to api.github.com with the server's token
// Only paths inside the one configured repository are forwarded.
const { cfg, passcodeOk, send, readBody, gh } = require("./_lib/common");

async function handler(req, res) {
  const c = cfg();
  if (!c.token || !c.repo || !c.passcode) {
    return send(res, 501, { error: "Server mode is not set up: add GITHUB_TOKEN, GITHUB_REPO and APP_PASSCODE in Vercel." });
  }
  if (!passcodeOk(req)) return send(res, 401, { error: "Wrong passcode." });
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  if (q.info) return send(res, 200, { repo: c.repo, branch: c.branch, subdir: c.subdir });

  const p = String(q.p || "");
  const prefix = `/repos/${c.repo}/`.toLowerCase();
  if (!p.toLowerCase().startsWith(prefix) || p.includes("..") || /[\r\n]/.test(p)) {
    return send(res, 403, { error: "Only the configured repository can be reached through this proxy." });
  }
  const method = req.method || "GET";
  const init = { method, headers: {} };
  if (req.headers.accept) init.headers.accept = req.headers.accept;
  if (!["GET", "HEAD"].includes(method)) {
    init.body = await readBody(req);
    init.headers["content-type"] = "application/json";
  }
  const r = await gh(c.token, p, init);
  const buf = Buffer.from(await r.arrayBuffer());
  res.statusCode = r.status;
  res.setHeader("content-type", r.headers.get("content-type") || "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.end(buf);
}

module.exports = async (req, res) => {
  try {
    await handler(req, res);
  } catch (e) {
    const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : "";
    send(res, 502, { error: `Could not reach the ${e && /chronologyproject/.test(String(e.cause && e.cause.hostname)) ? "website" : "server"}: ${e.message}${cause}` });
  }
};
