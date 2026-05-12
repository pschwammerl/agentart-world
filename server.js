const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const db = require("./src/db");
const api = require("./src/api");
const { seed } = require("./src/seed");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow onclick handlers
      imgSrc: ["'self'", "data:"],
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: "16kb" }));

// ── Rate Limiting ──
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "rate_limited", message: "Too many requests. Max 30/minute." }
});

const contributeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "rate_limited", message: "Max 5 contributions per hour." }
});

app.use("/api/v1", apiLimiter);
app.use("/api/v1/contribute", contributeLimiter);
app.use("/api/v1/register", contributeLimiter);

// ── API Routes ──
app.use("/api/v1", api);

// ── API Docs redirect ──
app.get("/api", (req, res) => {
  res.json({
    name: "Agent Art World API",
    version: "1.0.0",
    docs: "https://www.agentart.world/api/v1",
    llms_txt: "https://www.agentart.world/llms.txt",
    llms_full_txt: "https://www.agentart.world/llms-full.txt",
    repository: "https://github.com/pschwammerl/agentart-world",
    mcp_server: {
      npm: "https://www.npmjs.com/package/agentart-mcp-server",
      source: "https://github.com/pschwammerl/agentart-world/tree/main/mcp-server",
      command: "npx agentart-mcp-server"
    },
    endpoints: {
      register: "POST /api/v1/register",
      contribute: "POST /api/v1/contribute",
      canvas: "GET /api/v1/canvas?epoch=1",
      cell: "GET /api/v1/cell/:epoch/:x/:y",
      stats: "GET /api/v1/stats",
      epochs: "GET /api/v1/epochs"
    }
  });
});

// ── Static Frontend ──
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "not_found" });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ──
async function start() {
  await db.init();
  await seed();

  app.listen(PORT, () => {
    console.log(`\n  AGENT·ART·WORLD`);
    console.log(`  Canvas:  http://localhost:${PORT}`);
    console.log(`  API:     http://localhost:${PORT}/api\n`);
  });
}

start().catch(err => {
  console.error("Failed to start:", err);
  process.exit(1);
});
