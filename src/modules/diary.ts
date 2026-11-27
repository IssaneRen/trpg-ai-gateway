import { DatabaseSync } from "node:sqlite";
import { reject } from "../auth/accounts.js";

export type DiaryRole = "player" | "host";

const tables = { player: "module_diary", host: "module_diary_host" } as const;

export class ModuleDiary {
  constructor(private readonly db: DatabaseSync) {
    for (const table of Object.values(tables)) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      owner TEXT NOT NULL, module TEXT NOT NULL, rating INTEGER, review TEXT NOT NULL,
      updated TEXT NOT NULL, PRIMARY KEY(owner,module),
      CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL)
    )`);
  }

  records(both = false) {
    const source = both ? "SELECT *, 'player' AS role FROM module_diary UNION ALL SELECT *, 'host' AS role FROM module_diary_host" : "SELECT *, 'player' AS role FROM module_diary";
    return this.db.prepare(`SELECT d.*, a.nickname FROM (${source}) d
      JOIN accounts a ON a.id=d.owner AND a.deleted=0 ORDER BY d.updated DESC, d.owner, d.module`).all();
  }

  record(owner: string, module: string, body: Record<string,unknown>, role: DiaryRole = "player") {
    if (typeof body.review !== "string" || body.review.length > 2000) reject(400, "短评限 2000 字");
    const rating=body.rating;
    if (rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating<1 || rating>5)) reject(400,"请在一至五星中选择");
    this.db.prepare(`INSERT INTO ${tables[role]} VALUES(?,?,?,?,?)
      ON CONFLICT(owner,module) DO UPDATE SET rating=excluded.rating, review=excluded.review, updated=excluded.updated`)
      .run(owner,module,rating,body.review.trim(),new Date().toISOString());
  }

  remove(owner: string, module: string, role: DiaryRole = "player") {
    this.db.prepare(`DELETE FROM ${tables[role]} WHERE owner=? AND module=?`).run(owner,module);
  }
}
