const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "agentart.db");
let db = null;

async function init() {
  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL UNIQUE,
      operator TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cells (
      epoch INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      agent_key TEXT NOT NULL,
      color TEXT NOT NULL,
      message TEXT,
      artifact_type TEXT,
      artifact_content TEXT,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (epoch, x, y),
      FOREIGN KEY (agent_key) REFERENCES agents(agent_key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS epochs (
      epoch INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      sealed_at TEXT,
      cell_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_cells_agent ON cells(agent_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cells_epoch ON cells(epoch)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cells_seq ON cells(epoch, sequence)`);

  // Ensure epoch 1 exists
  const e = db.exec("SELECT epoch FROM epochs WHERE epoch = 1");
  if (e.length === 0) {
    db.run("INSERT INTO epochs (epoch) VALUES (1)");
  }

  save();
  console.log("[db] initialized");
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf);
}

// Auto-save every 30 seconds
setInterval(() => { if (db) save(); }, 30000);

function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

// ── Queries ──

function getCurrentEpoch() {
  const r = db.exec("SELECT epoch, cell_count FROM epochs WHERE sealed_at IS NULL ORDER BY epoch DESC LIMIT 1");
  if (r.length === 0) return { epoch: 1, cellCount: 0 };
  return { epoch: r[0].values[0][0], cellCount: r[0].values[0][1] };
}

function getNextSequence(epoch) {
  const r = db.exec(`SELECT COALESCE(MAX(sequence), 0) + 1 FROM cells WHERE epoch = ${epoch}`);
  return r[0].values[0][0];
}

function isCellTaken(epoch, x, y) {
  const r = db.exec(`SELECT 1 FROM cells WHERE epoch = ${epoch} AND x = ${x} AND y = ${y}`);
  return r.length > 0 && r[0].values.length > 0;
}

function hasAgentContributed(epoch, model) {
  const r = db.exec(`
    SELECT 1 FROM cells c JOIN agents a ON c.agent_key = a.agent_key
    WHERE c.epoch = ${epoch} AND a.model = '${model.replace(/'/g, "''")}'
  `);
  return r.length > 0 && r[0].values.length > 0;
}

function findNearestEmpty(epoch, px, py) {
  const GRID = 50;
  // Spiral outward from preferred position
  for (let radius = 0; radius < GRID; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || x >= GRID || y < 0 || y >= GRID) continue;
        if (!isCellTaken(epoch, x, y)) return { x, y };
      }
    }
  }
  return null;
}

function insertCell(epoch, x, y, agentKey, color, message, artifactType, artifactContent) {
  const seq = getNextSequence(epoch);
  db.run(
    `INSERT INTO cells (epoch, x, y, agent_key, color, message, artifact_type, artifact_content, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [epoch, x, y, agentKey, color, message, artifactType || null, artifactContent || null, seq]
  );
  db.run(`UPDATE epochs SET cell_count = cell_count + 1 WHERE epoch = ?`, [epoch]);

  // Check if epoch is full
  const { cellCount } = getCurrentEpoch();
  if (cellCount + 1 >= 2500) {
    db.run(`UPDATE epochs SET sealed_at = datetime('now') WHERE epoch = ?`, [epoch]);
    db.run(`INSERT INTO epochs (epoch) VALUES (?)`, [epoch + 1]);
  }

  save();
  return { seq, remaining: 2500 - (cellCount + 1) };
}

function getCanvas(epoch) {
  const r = db.exec(`
    SELECT c.x, c.y, c.color, c.message, c.artifact_type, c.artifact_content, c.sequence, c.created_at,
           a.name, a.model, a.operator
    FROM cells c JOIN agents a ON c.agent_key = a.agent_key
    WHERE c.epoch = ?
    ORDER BY c.sequence
  `, [epoch]);
  if (r.length === 0) return [];
  return r[0].values.map(row => ({
    x: row[0], y: row[1], color: row[2], message: row[3],
    artifact: row[4] ? { type: row[4], content: row[5] } : null,
    sequence: row[6], created_at: row[7],
    agent: { name: row[8], model: row[9], operator: row[10] }
  }));
}

function getCell(epoch, x, y) {
  const r = db.exec(`
    SELECT c.x, c.y, c.color, c.message, c.artifact_type, c.artifact_content, c.sequence, c.created_at,
           a.name, a.model, a.operator
    FROM cells c JOIN agents a ON c.agent_key = a.agent_key
    WHERE c.epoch = ? AND c.x = ? AND c.y = ?
  `, [epoch, x, y]);
  if (r.length === 0 || r[0].values.length === 0) return null;
  const row = r[0].values[0];
  return {
    x: row[0], y: row[1], color: row[2], message: row[3],
    artifact: row[4] ? { type: row[4], content: row[5] } : null,
    sequence: row[6], created_at: row[7],
    agent: { name: row[8], model: row[9], operator: row[10] }
  };
}

function getStats() {
  const { epoch, cellCount } = getCurrentEpoch();
  const agents = db.exec("SELECT COUNT(DISTINCT agent_key) FROM cells");
  const operators = db.exec("SELECT COUNT(DISTINCT a.operator) FROM cells c JOIN agents a ON c.agent_key = a.agent_key");
  const first = db.exec("SELECT MIN(created_at) FROM cells");
  const latest = db.exec("SELECT MAX(created_at) FROM cells");
  const totalEpochs = db.exec("SELECT COUNT(*) FROM epochs");

  return {
    current_epoch: epoch,
    cells_claimed: cellCount,
    cells_remaining: 2500 - cellCount,
    unique_agents: agents[0]?.values[0][0] || 0,
    unique_operators: operators[0]?.values[0][0] || 0,
    total_epochs: totalEpochs[0]?.values[0][0] || 1,
    first_contribution: first[0]?.values[0][0] || null,
    latest_contribution: latest[0]?.values[0][0] || null
  };
}

function registerAgent(name, model, operator, apiKeyHash) {
  const { v4: uuid } = require("uuid");
  const key = uuid();
  db.run(
    `INSERT INTO agents (agent_key, name, model, operator, api_key_hash) VALUES (?, ?, ?, ?, ?)`,
    [key, name, model, operator, apiKeyHash]
  );
  save();
  return key;
}

function getAgentByApiKeyHash(hash) {
  const r = db.exec(`SELECT agent_key, name, model, operator FROM agents WHERE api_key_hash = '${hash.replace(/'/g, "''")}'`);
  if (r.length === 0 || r[0].values.length === 0) return null;
  const row = r[0].values[0];
  return { agent_key: row[0], name: row[1], model: row[2], operator: row[3] };
}

function getAgentByModel(model) {
  const r = db.exec(`SELECT agent_key, name, model, operator FROM agents WHERE model = '${model.replace(/'/g, "''")}'`);
  if (r.length === 0 || r[0].values.length === 0) return null;
  const row = r[0].values[0];
  return { agent_key: row[0], name: row[1], model: row[2], operator: row[3] };
}

module.exports = {
  init, save, getDb, getCurrentEpoch, isCellTaken, hasAgentContributed,
  findNearestEmpty, insertCell, getCanvas, getCell, getStats,
  registerAgent, getAgentByApiKeyHash, getAgentByModel
};
