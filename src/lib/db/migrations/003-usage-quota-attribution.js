// Add logical request attribution without changing existing usage model values.
import { TABLES } from "../schema.js";

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.all(`PRAGMA table_info(${table})`);
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export default {
  version: 3,
  name: "usage-quota-attribution",
  up(db) {
    addColumnIfMissing(db, "usageHistory", "requestedModel", "TEXT");
    addColumnIfMissing(db, "usageHistory", "comboName", "TEXT");
    addColumnIfMissing(db, "usageHistory", "quotaRequestId", "TEXT");
    for (const index of TABLES.usageHistory.indexes || []) db.exec(index);
  },
};
