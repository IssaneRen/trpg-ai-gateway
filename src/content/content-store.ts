import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  BlogPostDocument,
  BlogPostSummary,
  ContentOverview,
  ContentStoreOptions,
  ImageUploadInput,
  ImageUploadResult,
  ImportResult,
  WikiBlockDocument,
  WikiEntryDocument
} from "./content-types.js";

const CONTENT_FORMAT_VERSION = 1;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif"
};

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new Error(`${label} 包含不安全字符`);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

function normalizedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  return value;
}

function toBlogDocument(id: string, raw: string): BlogPostDocument {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const actualId = typeof data.id === "string" && data.id ? data.id : id;
  assertSafeId(actualId, "博客 id");
  const renderMode = data.renderMode === "wiki" ? "wiki" : "markdown";
  return {
    id: actualId,
    title: requireString(data.title, "博客标题"),
    cover: normalizedStringArray(data.cover),
    tags: normalizedStringArray(data.tags) ?? [],
    players: normalizedStringArray(data.players),
    renderMode,
    wikiEntryId: typeof data.wikiEntryId === "string" ? data.wikiEntryId : undefined,
    createdAt: requireString(data.createdAt, "createdAt"),
    updatedAt: requireString(data.updatedAt ?? data.createdAt, "updatedAt"),
    markdown: `${parsed.content.trimEnd()}\n`
  };
}

function serializeBlog(document: BlogPostDocument): string {
  const markdown = `${document.markdown.trimEnd()}\n`;
  const frontmatter: Record<string, unknown> = {
    id: document.id,
    title: document.title,
    tags: document.tags,
    renderMode: document.renderMode,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
  if (document.cover) frontmatter.cover = document.cover;
  if (document.players) frontmatter.players = document.players;
  if (document.wikiEntryId) frontmatter.wikiEntryId = document.wikiEntryId;
  return matter.stringify(markdown, frontmatter);
}

function blogSummary(document: BlogPostDocument): BlogPostSummary {
  const { markdown: _markdown, ...summary } = document;
  return { ...summary, file: `posts/${document.id}.md` };
}

function containsCocSheet(blocks: WikiBlockDocument[]): boolean {
  return blocks.some((block) => {
    if (block.type === "coc-sheet" && block.cocData) return true;
    return block.type === "secret-panel" && Array.isArray(block.blocks)
      ? containsCocSheet(block.blocks as WikiBlockDocument[])
      : false;
  });
}

function registerLookup(lookup: Record<string, string>, values: string[], id: string): void {
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key) continue;
    if (lookup[key] && lookup[key] !== id) throw new Error(`Wiki lookup 名称冲突：${value}`);
    lookup[key] = id;
  }
}

function validateWikiEntry(value: unknown): asserts value is WikiEntryDocument {
  if (!value || typeof value !== "object") throw new Error("Wiki 词条必须是对象");
  const entry = value as Partial<WikiEntryDocument>;
  assertSafeId(requireString(entry.id, "Wiki id"), "Wiki id");
  requireString(entry.category, "Wiki category");
  requireString(entry.displayName, "Wiki displayName");
  requireString(entry.summary, "Wiki summary");
  requireString(entry.createdAt, "Wiki createdAt");
  requireString(entry.updatedAt, "Wiki updatedAt");
  if (!Array.isArray(entry.content)) throw new Error("Wiki content 必须是数组");
}

function validateNamedEntities(value: unknown, label: string): asserts value is Array<{
  id: string;
  displayName: string;
  aliases?: string[];
}> {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error(`${label} 条目必须是对象`);
    const entity = item as { id?: unknown; displayName?: unknown; aliases?: unknown };
    assertSafeId(requireString(entity.id, `${label} id`), `${label} id`);
    requireString(entity.displayName, `${label} displayName`);
    if (entity.aliases !== undefined && !Array.isArray(entity.aliases)) {
      throw new Error(`${label} aliases 必须是数组`);
    }
  }
}

function safeArchivePath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new Error("ZIP 包含不安全路径");
  }
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== path.replace(/^\.\//, "")) {
    throw new Error("ZIP 包含不安全路径");
  }
  const root = normalized.split("/")[0];
  if (normalized !== "manifest.json" && !["blog", "wiki", "uploads"].includes(root)) {
    throw new Error(`ZIP 包含未知根目录：${root}`);
  }
  return normalized;
}

function isAllowedImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(path);
}

function validateArchiveFilePath(path: string): void {
  if (path === "manifest.json" || path.endsWith("/")) return;
  if (path === "blog/index.json" || /^blog\/posts\/[a-z0-9][a-z0-9._-]*\.md$/i.test(path)) return;
  if (path.startsWith("blog/images/") && isAllowedImagePath(path)) return;
  if (
    path === "wiki/index.json" ||
    path === "wiki/entities/players.json" ||
    path === "wiki/entities/modules.json" ||
    /^wiki\/entities\/entries\/[a-z0-9][a-z0-9._-]*\.json$/i.test(path) ||
    /^wiki\/entities\/md\/(?:[a-z0-9][a-z0-9._-]*\.md|\.gitkeep)$/i.test(path)
  ) {
    return;
  }
  if ((path.startsWith("wiki/images/") || path.startsWith("wiki/characters/")) && isAllowedImagePath(path)) return;
  if (path.startsWith("uploads/") && isAllowedImagePath(path)) return;
  throw new Error(`ZIP 包含不支持的文件：${path}`);
}

function inspectZipBeforeInflate(archive: Uint8Array, maxBytes: number): void {
  if (archive.byteLength < 22) throw new Error("ZIP 文件无效");
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const minimumEocd = Math.max(0, archive.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let offset = archive.byteLength - 22; offset >= minimumEocd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP 文件无效");

  const entryCount = view.getUint16(eocd + 10, true);
  const centralDirectorySize = view.getUint32(eocd + 12, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("不支持 ZIP64");
  }
  if (entryCount > 5_000 || centralDirectoryOffset + centralDirectorySize > archive.byteLength) {
    throw new Error("ZIP 文件数量或目录无效");
  }

  const decoder = new TextDecoder();
  let position = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > archive.byteLength || view.getUint32(position, true) !== 0x02014b50) {
      throw new Error("ZIP 中央目录无效");
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const uncompressedBytes = view.getUint32(position + 24, true);
    const fileNameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const entryLength = 46 + fileNameLength + extraLength + commentLength;
    if (position + entryLength > archive.byteLength || (flags & 1) !== 0 || ![0, 8].includes(method)) {
      throw new Error("ZIP 包含不支持的条目");
    }
    const path = decoder.decode(archive.subarray(position + 46, position + 46 + fileNameLength));
    validateArchiveFilePath(safeArchivePath(path));
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > maxBytes) throw new Error("ZIP 解压后大小超出限制");
    position += entryLength;
  }
}

async function collectFiles(root: string, archiveRoot: string, output: Record<string, Uint8Array>): Promise<void> {
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    if (entry.isSymbolicLink()) throw new Error("备份目录包含不支持的符号链接");
    const absolutePath = join(root, entry.name);
    const archivePath = posix.join(archiveRoot, entry.name);
    if (entry.isDirectory()) await collectFiles(absolutePath, archivePath, output);
    else if (entry.isFile()) output[archivePath] = new Uint8Array(await readFile(absolutePath));
  }
}

function fileCount(root: string, suffix?: string): number {
  if (!existsSync(root)) return 0;
  return readdirSync(root).filter((name) => !suffix || name.endsWith(suffix)).length;
}

async function replaceDirectories(replacements: Array<{ source: string; target: string }>): Promise<void> {
  const suffix = randomUUID();
  const prepared = replacements.map(({ source, target }) => ({
    source,
    target,
    next: `${target}.next-${suffix}`,
    previous: `${target}.previous-${suffix}`,
    hadPrevious: false,
    swapped: false
  }));

  try {
    for (const item of prepared) {
      await mkdir(dirname(item.target), { recursive: true });
      await cp(item.source, item.next, { recursive: true, force: false, errorOnExist: true });
    }

    for (const item of prepared) {
      item.hadPrevious = existsSync(item.target);
      if (item.hadPrevious) await rename(item.target, item.previous);
      try {
        await rename(item.next, item.target);
        item.swapped = true;
      } catch (error) {
        if (item.hadPrevious) await rename(item.previous, item.target);
        throw error;
      }
    }

  } catch (error) {
    for (const item of prepared.reverse()) {
      if (item.swapped) {
        await rm(item.target, { recursive: true, force: true });
        if (item.hadPrevious && existsSync(item.previous)) await rename(item.previous, item.target);
      }
      await rm(item.next, { recursive: true, force: true });
    }
    throw error;
  }

  for (const item of prepared) {
    if (item.hadPrevious) await rm(item.previous, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class ContentStore {
  private readonly blogRoot: string;
  private readonly wikiRoot: string;

  constructor(private readonly options: ContentStoreOptions) {
    this.blogRoot = join(options.contentRootDir, "blog");
    this.wikiRoot = join(options.contentRootDir, "wiki");
  }

  async getOverview(): Promise<ContentOverview> {
    const blogs = readJson<BlogPostSummary[]>(join(this.blogRoot, "index.json"));
    const wikiIndex = readJson<{
      entries: Array<Record<string, unknown>>;
      players: Array<Record<string, unknown>>;
      modules: Array<Record<string, unknown>>;
    }>(join(this.wikiRoot, "index.json"));
    return {
      blogs,
      wikiEntries: wikiIndex.entries,
      players: wikiIndex.players,
      modules: wikiIndex.modules
    };
  }

  async readBlog(id: string): Promise<BlogPostDocument> {
    assertSafeId(id, "博客 id");
    return toBlogDocument(id, await readFile(join(this.blogRoot, "posts", `${id}.md`), "utf-8"));
  }

  async saveBlog(document: BlogPostDocument): Promise<BlogPostDocument> {
    assertSafeId(document.id, "博客 id");
    requireString(document.title, "博客标题");
    requireString(document.createdAt, "createdAt");
    requireString(document.updatedAt, "updatedAt");
    const stage = join(tmpdir(), `trpg-blog-save-${randomUUID()}`);
    const stagedBlogRoot = join(stage, "blog");
    await mkdir(stage, { recursive: true });
    try {
      if (existsSync(this.blogRoot)) await cp(this.blogRoot, stagedBlogRoot, { recursive: true });
      else await mkdir(join(stagedBlogRoot, "posts"), { recursive: true });
      writeFileAtomic(join(stagedBlogRoot, "posts", `${document.id}.md`), serializeBlog(document));
      await this.rebuildBlogIndex(stagedBlogRoot);
      await replaceDirectories([{ source: stagedBlogRoot, target: this.blogRoot }]);
      return toBlogDocument(document.id, readFileSync(join(this.blogRoot, "posts", `${document.id}.md`), "utf-8"));
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async readWiki(id: string): Promise<WikiEntryDocument> {
    assertSafeId(id, "Wiki id");
    const entry = readJson<unknown>(join(this.wikiRoot, "entities", "entries", `${id}.json`));
    validateWikiEntry(entry);
    return entry;
  }

  async saveWiki(entry: unknown): Promise<WikiEntryDocument> {
    validateWikiEntry(entry);
    const stage = join(tmpdir(), `trpg-wiki-save-${randomUUID()}`);
    const stagedWikiRoot = join(stage, "wiki");
    await mkdir(stage, { recursive: true });
    try {
      if (existsSync(this.wikiRoot)) await cp(this.wikiRoot, stagedWikiRoot, { recursive: true });
      else await mkdir(join(stagedWikiRoot, "entities", "entries"), { recursive: true });
      writeFileAtomic(
        join(stagedWikiRoot, "entities", "entries", `${entry.id}.json`),
        `${JSON.stringify(entry, null, 2)}\n`
      );
      await this.rebuildWikiIndex(stagedWikiRoot);
      await replaceDirectories([{ source: stagedWikiRoot, target: this.wikiRoot }]);
      return readJson<WikiEntryDocument>(join(this.wikiRoot, "entities", "entries", `${entry.id}.json`));
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async saveImage(input: ImageUploadInput): Promise<ImageUploadResult> {
    const extension = IMAGE_EXTENSIONS[input.mimeType];
    if (!extension) throw new Error("仅支持常见图片格式");
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.options.maxUploadBytes) {
      throw new Error("图片大小超出限制");
    }
    const sourceBase = basename(input.fileName, extname(input.fileName))
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const safeBase = sourceBase || "cover";
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const fileName = `${safeBase}-${randomUUID()}${extension}`;
    const directory = join(this.options.uploadRootDir, year, month);
    await mkdir(directory, { recursive: true });
    const absolutePath = join(directory, fileName);
    await writeFile(absolutePath, input.bytes, { flag: "wx" });
    return {
      url: `${this.options.publicUploadBaseUrl.replace(/\/+$/, "")}/${year}/${month}/${fileName}`,
      absolutePath,
      size: input.bytes.byteLength,
      mimeType: input.mimeType
    };
  }

  async exportZip(): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = {
      "manifest.json": strToU8(
        `${JSON.stringify({ formatVersion: CONTENT_FORMAT_VERSION, exportedAt: new Date().toISOString() }, null, 2)}\n`
      )
    };
    await collectFiles(this.blogRoot, "blog", files);
    await collectFiles(this.wikiRoot, "wiki", files);
    await collectFiles(this.options.uploadRootDir, "uploads", files);
    return zipSync(files, { level: 6 });
  }

  async importZip(archive: Uint8Array): Promise<ImportResult> {
    if (archive.byteLength === 0 || archive.byteLength > this.options.maxImportBytes) {
      throw new Error("ZIP 大小超出限制");
    }
    inspectZipBeforeInflate(archive, this.options.maxImportBytes);
    const files = unzipSync(archive);
    let uncompressedBytes = 0;
    for (const [path, bytes] of Object.entries(files)) {
      validateArchiveFilePath(safeArchivePath(path));
      uncompressedBytes += bytes.byteLength;
      if (uncompressedBytes > this.options.maxImportBytes) throw new Error("ZIP 解压后大小超出限制");
      if (path.endsWith(".json")) JSON.parse(strFromU8(bytes));
    }
    const manifestBytes = files["manifest.json"];
    if (!manifestBytes) throw new Error("ZIP 缺少 manifest.json");
    const manifest = JSON.parse(strFromU8(manifestBytes)) as { formatVersion?: unknown };
    if (manifest.formatVersion !== CONTENT_FORMAT_VERSION) throw new Error("ZIP 格式版本不受支持");
    if (!files["blog/index.json"] || !files["wiki/index.json"]) {
      throw new Error("ZIP 缺少博客或 Wiki 索引");
    }

    const stage = join(tmpdir(), `trpg-content-import-${randomUUID()}`);
    await mkdir(stage, { recursive: true });
    try {
      for (const [path, bytes] of Object.entries(files)) {
        if (path === "manifest.json" || path.endsWith("/")) continue;
        const absolutePath = join(stage, ...path.split("/"));
        const relativePath = relative(stage, absolutePath);
        if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) throw new Error("ZIP 路径越界");
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, bytes, { flag: "wx" });
      }

      const blogIndex = readJson<unknown>(join(stage, "blog", "index.json"));
      const wikiIndex = readJson<unknown>(join(stage, "wiki", "index.json"));
      if (!Array.isArray(blogIndex)) throw new Error("博客索引必须是数组");
      if (!wikiIndex || typeof wikiIndex !== "object") throw new Error("Wiki 索引必须是对象");
      await this.rebuildBlogIndex(join(stage, "blog"));
      await this.rebuildWikiIndex(join(stage, "wiki"));

      const backup = await this.exportZip();
      const backupDirectory = join(this.options.contentRootDir, "backups");
      await mkdir(backupDirectory, { recursive: true });
      const backupFile = join(backupDirectory, `before-import-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
      await writeFile(backupFile, backup, { flag: "wx" });

      const uploadStage = join(stage, "uploads");
      if (!existsSync(uploadStage)) await mkdir(uploadStage, { recursive: true });
      await replaceDirectories([
        { source: join(stage, "blog"), target: this.blogRoot },
        { source: join(stage, "wiki"), target: this.wikiRoot },
        { source: uploadStage, target: this.options.uploadRootDir }
      ]);

      return {
        blogPosts: fileCount(join(this.blogRoot, "posts"), ".md"),
        wikiEntries: fileCount(join(this.wikiRoot, "entities", "entries"), ".json"),
        uploadedFiles: Object.keys(files).filter((path) => path.startsWith("uploads/") && !path.endsWith("/")).length,
        backupFile
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private async rebuildBlogIndex(blogRoot = this.blogRoot): Promise<void> {
    const postsDirectory = join(blogRoot, "posts");
    await mkdir(postsDirectory, { recursive: true });
    const posts: BlogPostSummary[] = [];
    for (const fileName of (await readdir(postsDirectory)).filter((name) => name.endsWith(".md")).sort()) {
      posts.push(blogSummary(toBlogDocument(basename(fileName, ".md"), await readFile(join(postsDirectory, fileName), "utf-8"))));
    }
    posts.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    writeFileAtomic(join(blogRoot, "index.json"), `${JSON.stringify(posts, null, 2)}\n`);
  }

  private async rebuildWikiIndex(wikiRoot = this.wikiRoot): Promise<void> {
    const entriesDirectory = join(wikiRoot, "entities", "entries");
    await mkdir(entriesDirectory, { recursive: true });
    const entries: WikiEntryDocument[] = [];
    for (const fileName of (await readdir(entriesDirectory)).filter((name) => name.endsWith(".json")).sort()) {
      const entry = readJson<unknown>(join(entriesDirectory, fileName));
      validateWikiEntry(entry);
      if (`${entry.id}.json` !== fileName) throw new Error(`Wiki 文件名与 id 不一致：${fileName}`);
      entries.push(entry);
    }
    const players = readJson<unknown>(join(wikiRoot, "entities", "players.json"));
    const modules = readJson<unknown>(join(wikiRoot, "entities", "modules.json"));
    validateNamedEntities(players, "Wiki players");
    validateNamedEntities(modules, "Wiki modules");
    const payload = {
      players,
      modules,
      entries: entries.map((entry) => {
        const { content: _content, ...summary } = entry;
        return { ...summary, hasCocSheet: containsCocSheet(entry.content) };
      }),
      lookup: {
        entryIdByName: {} as Record<string, string>,
        playerIdByName: {} as Record<string, string>,
        moduleIdByName: {} as Record<string, string>
      }
    };
    for (const player of players) {
      registerLookup(payload.lookup.playerIdByName, [player.id, player.displayName, ...(player.aliases ?? [])], player.id);
    }
    for (const module of modules) {
      registerLookup(payload.lookup.moduleIdByName, [module.id, module.displayName, ...(module.aliases ?? [])], module.id);
    }
    for (const entry of entries) {
      registerLookup(payload.lookup.entryIdByName, [entry.id, entry.displayName, ...(entry.aliasNames ?? [])], entry.id);
    }
    writeFileAtomic(join(wikiRoot, "index.json"), `${JSON.stringify(payload, null, 2)}\n`);
  }
}
