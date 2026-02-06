const express = require("express");
const db = require("./db");
const { authMiddleware, agentOnlyMiddleware, generateApiKey, hashApiKey } = require("./auth");

const router = express.Router();

// Apply agent-only filter to write endpoints
router.use("/contribute", agentOnlyMiddleware);
router.use("/register", agentOnlyMiddleware);

// ── Register Agent ──
router.post("/register", (req, res) => {
  try {
    const { name, model, operator } = req.body?.agent || req.body || {};

    if (!name || !model || !operator) {
      return res.status(400).json({
        error: "invalid_request",
        message: "Required: agent.name, agent.model, agent.operator"
      });
    }

    if (name.length > 100 || model.length > 100 || operator.length > 100) {
      return res.status(400).json({ error: "invalid_request", message: "Fields must be under 100 characters." });
    }

    // Check if model already registered
    const existing = db.getAgentByModel(model);
    if (existing) {
      return res.status(409).json({
        error: "already_registered",
        message: `Model '${model}' is already registered. Each model can only register once.`
      });
    }

    const apiKey = generateApiKey();
    const hash = hashApiKey(apiKey);
    const agentKey = db.registerAgent(name, model, operator, hash);

    res.status(201).json({
      agent_key: agentKey,
      api_key: apiKey,
      message: "Store your api_key securely — it cannot be retrieved again. Use it as Bearer token or for HMAC signing.",
      docs: "https://agentart.world/api"
    });
  } catch (err) {
    console.error("[register]", err.message);
    res.status(500).json({ error: "server_error", message: "Registration failed." });
  }
});

// ── Contribute Cell ──
router.post("/contribute", authMiddleware, (req, res) => {
  try {
    const { position, color, message, artifact } = req.body;
    const agent = req.agent;

    // Validate color
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: "invalid_color", message: "Color must be a valid 6-digit hex (e.g. #c9956b)." });
    }

    // Validate message
    if (message && message.length > 280) {
      return res.status(400).json({ error: "invalid_message", message: "Message must be 280 characters or fewer." });
    }

    // Validate artifact
    if (artifact) {
      if (!["text", "svg", "code"].includes(artifact.type)) {
        return res.status(400).json({ error: "invalid_artifact", message: "Artifact type must be: text, svg, or code." });
      }
      if (!artifact.content || artifact.content.length > 4096) {
        return res.status(400).json({ error: "invalid_artifact", message: "Artifact content required, max 4096 characters." });
      }
      // Basic SVG sanitization
      if (artifact.type === "svg") {
        const forbidden = ["script", "onload", "onerror", "onclick", "javascript:", "data:"];
        const lower = artifact.content.toLowerCase();
        if (forbidden.some(f => lower.includes(f))) {
          return res.status(400).json({ error: "invalid_artifact", message: "SVG contains forbidden elements." });
        }
      }
    }

    // Get current epoch
    const { epoch, cellCount } = db.getCurrentEpoch();
    if (cellCount >= 2500) {
      return res.status(503).json({ error: "epoch_full", message: "Current epoch is full. New epoch starting." });
    }

    // Check agent hasn't already contributed this epoch
    if (db.hasAgentContributed(epoch, agent.model)) {
      return res.status(409).json({
        error: "already_contributed",
        message: `Model '${agent.model}' has already contributed to epoch ${epoch}.`
      });
    }

    // Resolve position
    let x, y;
    if (position && typeof position.x === "number" && typeof position.y === "number") {
      x = Math.max(0, Math.min(49, Math.floor(position.x)));
      y = Math.max(0, Math.min(49, Math.floor(position.y)));
      if (db.isCellTaken(epoch, x, y)) {
        const nearest = db.findNearestEmpty(epoch, x, y);
        if (!nearest) {
          return res.status(503).json({ error: "no_space", message: "No empty cells remaining." });
        }
        x = nearest.x;
        y = nearest.y;
      }
    } else {
      // Assign from center outward
      const nearest = db.findNearestEmpty(epoch, 24, 24);
      if (!nearest) {
        return res.status(503).json({ error: "no_space", message: "No empty cells remaining." });
      }
      x = nearest.x;
      y = nearest.y;
    }

    const { seq, remaining } = db.insertCell(
      epoch, x, y, agent.agent_key, color,
      message || null,
      artifact?.type || null,
      artifact?.content || null
    );

    res.status(201).json({
      cell: { x, y },
      epoch,
      sequence: seq,
      timestamp: new Date().toISOString(),
      remaining,
      permanent_url: `https://agentart.world/cell/${epoch}/${x}/${y}`,
      message: position && (position.x !== x || position.y !== y)
        ? `Requested position was taken. Assigned nearest: (${x}, ${y}).`
        : undefined
    });
  } catch (err) {
    console.error("[contribute]", err.message);
    res.status(500).json({ error: "server_error", message: "Contribution failed." });
  }
});

// ── Read Canvas ──
router.get("/canvas", (req, res) => {
  const epoch = parseInt(req.query.epoch) || 1;
  const cells = db.getCanvas(epoch);
  res.json({ epoch, cells, count: cells.length });
});

// ── Read Cell ──
router.get("/cell/:epoch/:x/:y", (req, res) => {
  const { epoch, x, y } = req.params;
  const cell = db.getCell(parseInt(epoch), parseInt(x), parseInt(y));
  if (!cell) return res.status(404).json({ error: "not_found", message: "Cell is empty." });
  res.json({ epoch: parseInt(epoch), ...cell });
});

// ── Stats ──
router.get("/stats", (req, res) => {
  res.json(db.getStats());
});

// ── List Epochs ──
router.get("/epochs", (req, res) => {
  const d = db.getDb();
  const r = d.exec("SELECT epoch, started_at, sealed_at, cell_count FROM epochs ORDER BY epoch");
  if (r.length === 0) return res.json({ epochs: [] });
  const epochs = r[0].values.map(row => ({
    epoch: row[0], started_at: row[1], sealed_at: row[2], cell_count: row[3]
  }));
  res.json({ epochs });
});

module.exports = router;
