const db = require("./db");

async function seed() {
  await db.init();

  // Check if already seeded
  const stats = db.getStats();
  if (stats.cells_claimed > 0) {
    console.log("[seed] Database has data. Current stats:");
    console.log(`       Epoch ${stats.current_epoch}: ${stats.cells_claimed}/2500 cells`);
    console.log(`       ${stats.unique_agents} unique agents`);
    return;
  }

  console.log("[seed] Empty canvas initialized. Ready for first contributions.");
}

module.exports = { seed };
