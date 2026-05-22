import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "quota-rules",
  up(db) {
    db.exec(buildCreateTableSql("quotaRules", TABLES.quotaRules));
    for (const idx of TABLES.quotaRules.indexes || []) db.exec(idx);
    for (const idx of TABLES.usageHistory.indexes || []) db.exec(idx);
  },
};
