// Shared helpers for the two Vercel functions. Files under api/_lib are not exposed as endpoints.
const crypto = require("crypto");

function cfg() {
  const repo = (process.env.GITHUB_REPO || "").trim(); // "owner/name"
  return {
    token: (process.env.GITHUB_TOKEN || "").trim(),
    repo,
    branch: (process.env.GITHUB_BRANCH || "main").trim(),
    subdir: (process.env.GITHUB_SUBDIR || "").trim().replace(/^\/+|\/+$/g, ""),
    passcode: process.env.APP_PASSCODE || "",
  };
}

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// true when the request carries the right passcode for the server-held token
function passcodeOk(req) {
  const c = cfg();
  return Boolean(c.passcode && c.token && c.repo && safeEqual(req.headers["x-app-passcode"] || "", c.passcode));
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== "string" && !Buffer.isBuffer(req.body)) {
    return JSON.stringify(req.body);
  }
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}

function gh(token, path, init = {}) {
  return fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "mcp-reading-order-pwa",
      ...(init.headers || {}),
    },
  });
}

module.exports = { cfg, passcodeOk, send, readBody, gh };
