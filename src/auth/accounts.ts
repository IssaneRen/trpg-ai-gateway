import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../config.js";

const derive = promisify(scrypt);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function reject(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
function field(v: unknown, max: number) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    reject(400, "字段为空或过长");
  return v;
}
function accountId(v: unknown) {
  const id = field(v, 64).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) reject(400, "账号 ID 格式错误");
  return id;
}
async function hash(password: unknown, salt = randomBytes(16).toString("hex")) {
  const key = (await derive(field(password, 256), salt, 32)) as Buffer;
  return salt + ":" + key.toString("hex");
}
const visible = "id, nickname, avatar, role";
export class Accounts {
  constructor(readonly db: DatabaseSync) {}
  static async open(config: RuntimeConfig) {
    const dir = join(config.workbenchRootDir, "accounts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "accounts.sqlite");
    const db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY COLLATE NOCASE,nickname TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',role TEXT NOT NULL CHECK(role IN ('admin','verified','registered')),password TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_owner ON sessions(id);`);
    try {
      for (const pl of config.tokenHashRecords.filter(
        (p) => !p.isKeeper && config.supportedPlayerIds.includes(p.playerId),
      )) {
        if (
          !db.prepare("SELECT id FROM accounts WHERE id=?").get(pl.playerId)
        ) {
          db.prepare(
            "INSERT OR IGNORE INTO accounts(id,nickname,role,password) VALUES(?,?,'registered',?)",
          ).run(pl.playerId, pl.displayName, await hash("123456"));
        }
      }
      return new Accounts(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  profile(id: string) {
    return this.db
      .prepare("SELECT " + visible + " FROM accounts WHERE id=? AND deleted=0")
      .get(id);
  }
  isDeleted(id: string) {
    return !!this.db
      .prepare("SELECT id FROM accounts WHERE id=? AND deleted=1")
      .get(id);
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,nickname,role FROM accounts WHERE deleted=0 ORDER BY id",
      )
      .all();
  }
  async create(
    idInput: unknown,
    nick: unknown,
    pass: unknown,
    role = "registered",
  ) {
    const id = accountId(idInput);
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO accounts(id,nickname,role,password) VALUES(?,?,?,?)",
      )
      .run(id, field(nick, 40).trim(), role, await hash(pass));
    if (!info.changes) reject(409, "账号 ID 已使用");
    return this.profile(id);
  }
  async login(idInput: unknown, password: unknown) {
    const id = accountId(idInput);
    const row = this.db
      .prepare("SELECT password FROM accounts WHERE id=? AND deleted=0")
      .get(id);
    const saved = String(
      row?.password ?? "00000000000000000000000000000000:" + "0".repeat(64),
    );
    const actual = await hash(password, saved.split(":")[0]);
    if (!timingSafeEqual(Buffer.from(saved), Buffer.from(actual)) || !row)
      reject(401, "账号或密码错误");
    const key = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
    const inserted = this.db
      .prepare(
        "INSERT INTO sessions SELECT ?,id,? FROM accounts WHERE id=? AND deleted=0 AND password=?",
      )
      .run(digest(key), Date.now() + 7 * 86400000, id, saved);
    if (!inserted.changes) reject(401, "请重新登录");
    return key;
  }
  current(key: string) {
    return this.db
      .prepare(
        "SELECT a.id AS playerId,nickname AS displayName,role FROM sessions s JOIN accounts a ON s.id=a.id WHERE s.hash=? AND s.expires>? AND a.deleted=0",
      )
      .get(digest(key), Date.now());
  }
  logout(key: string) {
    this.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(key));
  }
  remove(id: string) {
    if (
      !this.db
        .prepare(
          "UPDATE accounts SET deleted=1,password='',avatar='' WHERE id=? AND role!='admin' AND deleted=0",
        )
        .run(id).changes
    )
      reject(409, "账号不存在或为管理员");
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
  async edit(id: string, body: Record<string, unknown>) {
    const nick = field(body.nickname, 40).trim();
    const avatar = body.avatar;
    if (
      typeof avatar !== "string" ||
      avatar.length > 350000 ||
      (avatar &&
        !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+=*$/i.test(avatar))
    )
      reject(400, "头像格式或大小不合适");
    if (body.password) {
      const key = await hash(body.password);
      this.db
        .prepare(
          "UPDATE accounts SET nickname=?,avatar=?,password=? WHERE id=? AND deleted=0",
        )
        .run(nick, avatar, key, id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    } else
      this.db
        .prepare(
          "UPDATE accounts SET nickname=?,avatar=? WHERE id=? AND deleted=0",
        )
        .run(nick, avatar, id);
  }
}
