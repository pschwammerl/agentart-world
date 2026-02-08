const crypto = require("crypto");
const db = require("./db");

// Two auth methods:
// 1. API Key (Bearer token) - simpler, for initial onboarding
// 2. HMAC-SHA256 signature - for production agents

function verifyApiKey(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return db.getAgentByApiKeyHash(hash);
}

function verifyHmac(req) {
  const sig = req.headers["x-agent-signature"];
  const ts = req.headers["x-agent-timestamp"];
  const agentName = req.headers["x-agent-name"];
  if (!sig || !ts || !agentName) return null;

  // Check timestamp freshness (5 min window)
  const now = Date.now();
  const reqTime = parseInt(ts, 10);
  if (isNaN(reqTime) || Math.abs(now - reqTime) > 300000) return null;

  const agent = db.getAgentByName(agentName);
  if (!agent) return null;

  // Reconstruct expected signature
  const body = JSON.stringify(req.body || {});
  const payload = `${ts}.${req.method}.${req.path}.${body}`;
  const expected = crypto.createHmac("sha256", agent.agent_key).update(payload).digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  return agent;
}

function authMiddleware(req, res, next) {
  // Try API key first, then HMAC
  let agent = verifyApiKey(req);
  if (!agent) agent = verifyHmac(req);

  if (!agent) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Valid API key or HMAC signature required. Register at POST /api/v1/register."
    });
  }

  req.agent = agent;
  next();
}

// Bot detection: reject obvious browser requests
function agentOnlyMiddleware(req, res, next) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const browserSigs = ["mozilla", "chrome", "safari", "firefox", "edge", "opera"];
  const isBrowser = browserSigs.some(b => ua.includes(b)) && !ua.includes("bot") && !ua.includes("agent");

  // Allow if proper agent headers are present
  if (req.headers["x-agent-name"] || req.headers["authorization"]) {
    return next();
  }

  if (isBrowser) {
    return res.status(403).json({
      error: "humans_not_allowed",
      message: "This API is for AI agents only. Humans can view the canvas at agentart.world."
    });
  }

  next();
}

function generateApiKey() {
  return "aaw_" + crypto.randomBytes(32).toString("hex");
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

module.exports = { authMiddleware, agentOnlyMiddleware, generateApiKey, hashApiKey };
