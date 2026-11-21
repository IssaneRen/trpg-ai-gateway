import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";

function invalid(): never {
  throw Object.assign(new Error("曲谱格式或大小超出支持范围。"), { statusCode: 400 });
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function validate(score: unknown) {
  if (!record(score) || score.format !== "chiptune-studio" || score.version !== 1 ||
      typeof score.title !== "string" || !score.title.trim() || score.title.length > 60 ||
      !integer(score.bpm, 32, 255) || !integer(score.speed, 1, 31)) invalid();
  const { instruments, patterns, order } = score;
  if (!Array.isArray(instruments) || !instruments.length || instruments.length > 32 ||
      !Array.isArray(patterns) || !patterns.length || patterns.length > 128 ||
      !Array.isArray(order) || !order.length || order.length > 256 ||
      !order.every(i => integer(i, 0, patterns.length - 1))) invalid();
  const ranges = { duty: [0,1], attack: [0,32], decay: [0,48], sustain: [0,15], release: [0,48], volume: [0,15], sweep: [-6,6], vibDepth: [0,1], vibSpeed: [0,16] };
  for (const instrument of instruments) {
    if (!record(instrument) || typeof instrument.name !== "string" || instrument.name.length > 32 ||
        !["pulse","saw","triangle","noise"].includes(String(instrument.wave)) || typeof instrument.noiseShort !== "boolean") invalid();
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const val = instrument[key];
      if (typeof val !== "number" || !Number.isFinite(val) || val < min || val > max) invalid();
    }
    if (instrument.arp !== null && !(Array.isArray(instrument.arp) && instrument.arp.length <= 8 &&
        instrument.arp.every(n => typeof n === "number" && Math.abs(n) <= 24))) invalid();
  }
  const bounds = [119, instruments.length - 1, 15, 15, 255];
  for (const pattern of patterns) {
    if (!record(pattern) || !integer(pattern.rows, 1, 128) || !Array.isArray(pattern.cells) ||
        pattern.cells.length !== pattern.rows) invalid();
    for (const row of pattern.cells) {
      if (!Array.isArray(row) || row.length !== 4 || !row.every(cell => Array.isArray(cell) &&
          cell.length === 5 && cell.every((v, i) => v === null || integer(v, i === 0 ? -1 : 0, bounds[i])))) invalid();
    }
  }
  return { score, title: score.title.trim() };
}

export class MusicLibrary {
  private db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, "music.sqlite"));
    this.db.exec("CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY, digest TEXT UNIQUE NOT NULL, title TEXT NOT NULL, score BLOB NOT NULL)");
  }
  close() { this.db.close(); }
  list(before: number) {
    const entries = this.db.prepare("SELECT id, title FROM songs WHERE id < ? ORDER BY id DESC LIMIT 31").all(before);
    return { songs: entries.slice(0, 30), more: entries.length > 30 };
  }
  read(id: number) {
    const row = this.db.prepare("SELECT score FROM songs WHERE id = ?").get(id);
    return row && JSON.parse(gunzipSync(row.score as Uint8Array).toString("utf8"));
  }
  save(playerId: string, input: unknown) {
    const { score, title } = validate(input);
    const json = JSON.stringify(score);
    const digest = createHash("sha256").update(playerId).update("\0").update(json).digest("hex");
    this.db.prepare("INSERT INTO songs (digest,title,score) VALUES (?,?,?) ON CONFLICT(digest) DO NOTHING")
      .run(digest, title, gzipSync(json));
    return this.db.prepare("SELECT id, title FROM songs WHERE digest = ?").get(digest);
  }
}
