import { DatabaseSync } from "node:sqlite";
import { reject } from "../auth/accounts.js";

export class ModuleDiary {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS module_diary (
      owner TEXT NOT NULL, module TEXT NOT NULL, rating INTEGER, review TEXT NOT NULL,
      updated TEXT NOT NULL, PRIMARY KEY(owner,module),
      CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL)
    )`);
  }

  records() {
    return this.db.prepare(`SELECT d.*, a.nickname FROM module_diary d
      JOIN accounts a ON a.id=d.owner AND a.deleted=0 ORDER BY d.updated DESC, d.owner, d.module`).all();
  }

  record(owner: string, module: string, body: Record<string,unknown>) {
    if (typeof body.review !== "string" || body.review.length > 2000) reject(400, "短评限 2000 字");
    const rating=body.rating;
    if (rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating<1 || rating>5)) reject(400,"请在一至五星中选择");
    this.db.prepare(`INSERT INTO module_diary VALUES(?,?,?,?,?)
      ON CONFLICT(owner,module) DO UPDATE SET rating=excluded.rating, review=excluded.review, updated=excluded.updated`)
      .run(owner,module,rating,body.review.trim(),new Date().toISOString());
  }

  remove(owner: string, module: string) {
    this.db.prepare("DELETE FROM module_diary WHERE owner=? AND module=?").run(owner,module);
  }
}
