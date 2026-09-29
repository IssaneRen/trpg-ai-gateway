import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkKind = "ai-comic" | "trpg-log" | "ai-image" | "ai-novel" | "novel" | "html";
export interface Plan { id: string; title: string; detail: string; dueDate: string; status: "todo" | "doing" | "done"; }
export interface Learning { id: string; title: string; vendor: string; model: string; work: string; workflow: string; notes: string; status: "planned" | "learning" | "learned"; }
export interface Work { id: string; title: string; kind: WorkKind; summary: string; body: string; coverUrl: string; status: "draft" | "published"; updatedAt: string; }
export interface WorkbenchData { version: 1; plans: Plan[]; learning: Learning[]; works: Work[]; }

const kinds = new Set<WorkKind>(["ai-comic", "trpg-log", "ai-image", "ai-novel", "novel", "html"]);
const empty = (): WorkbenchData => ({ version: 1, plans: [], learning: [], works: [] });
const text = (value: unknown, name: string, max = 100_000): string => {
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be a string up to ${max} characters`);
  return value;
};
const id = (value: unknown): string => {
  const result = text(value, "id", 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("invalid id");
  return result;
};
function rows(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${name} must be an array of at most 1000 objects`);
  }
  return value as Record<string, unknown>[];
}
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new Error(`invalid ${name}`);
  return value as T;
}
export function validateWorkbenchData(value: unknown): WorkbenchData {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("unsupported workbench format");
  const data = value as Record<string, unknown>;
  const plans = rows(data.plans, "plans").map((row) => ({
    id: id(row.id), title: text(row.title, "title", 200), detail: text(row.detail, "detail"),
    dueDate: text(row.dueDate, "dueDate", 40), status: choice(row.status, ["todo", "doing", "done"], "plan status")
  }));
  const learning = rows(data.learning, "learning").map((row) => ({
    id: id(row.id), title: text(row.title, "title", 200), vendor: text(row.vendor, "vendor", 100),
    model: text(row.model, "model", 100), work: text(row.work, "work", 100),
    workflow: text(row.workflow, "workflow"), notes: text(row.notes, "notes"),
    status: choice(row.status, ["planned", "learning", "learned"], "learning status")
  }));
  const works = rows(data.works, "works").map((row) => ({
    id: id(row.id), title: text(row.title, "title", 200), kind: choice(row.kind, [...kinds], "work kind"),
    summary: text(row.summary, "summary", 2000), body: text(row.body, "body", 500_000),
    coverUrl: text(row.coverUrl, "coverUrl", 2000), status: choice(row.status, ["draft", "published"], "work status"),
    updatedAt: text(row.updatedAt, "updatedAt", 50)
  }));
  for (const list of [plans, learning, works]) {
    if (new Set(list.map((item) => item.id)).size !== list.length) throw new Error("duplicate id");
  }
  return { version: 1, plans, learning, works };
}

export class WorkbenchStore {
  private readonly file: string;
  private readonly key: Buffer;

  constructor(root: string, secret: string) {
    this.file = join(root, "workbench.v1.enc.json");
    this.key = Buffer.from(hkdfSync("sha256", secret, "trpg-workbench-v1", "content-encryption", 32));
  }

  async read(): Promise<WorkbenchData> {
    let file: string;
    try { file = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
    const envelope = JSON.parse(file) as { version: number; iv: string; tag: string; ciphertext: string };
    if (envelope.version !== 1) throw new Error("unsupported encrypted workbench format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    return validateWorkbenchData(JSON.parse(plaintext.toString("utf8")));
  }

  async write(input: unknown): Promise<WorkbenchData> {
    const data = validateWorkbenchData(input);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
    await writeFile(temporary, envelope, { mode: 0o600 });
    await rename(temporary, this.file);
    return data;
  }
}
