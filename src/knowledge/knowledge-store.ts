import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const documentKinds = ["module", "setting", "scene", "clue", "character", "location", "event"] as const;
type DocumentKind = typeof documentKinds[number];
type World = { id: string; name: string };
type DocumentSummary = { id: string; title: string; kind: DocumentKind; revision: number; wikiId: string; updatedAt: string };
type Document = DocumentSummary & { body: string; source: string };
type Relation = { id: string; sourceId: string; targetId: string; label: string };
type Publication = { id: string; kind: "module" | "setting"; title: string; summary: string; body: string; coverUrl: string; status: "published"; updatedAt: string };
type Token = { id: string; label: string; scope: "read" | "write" };

// 把可以安全展示给调用者的错误附上 HTTP 状态，供接口层统一返回。
export function knowledgeError(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) knowledgeError(400, "请输入有效的 JSON 对象。");
  return input as Record<string, unknown>;
}

function field(input: unknown, limit: number, required = false): string {
  if (typeof input !== "string" || input.length > limit || (required && !input.trim())) {
    knowledgeError(400, `必填内容不能为空，字段最多 ${limit} 字。`);
  }
  return input;
}

function id() {
  return randomBytes(16).toString("hex");
}

// Agent 凭据由随机数生成。数据库保存它的指纹，收到请求时用同样的方法算出指纹并查找。
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  // 先取得此库的写入权，再读取用于判断冲突的数据。一组写入全部成功才提交。
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function prepareDatabase(db: DatabaseSync, schema: string) {
  // WAL 是 SQLite 的预写日志。短暂的锁竞争可等待两秒，外键约束负责校验文章关系。
  db.exec("PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  transaction(db, () => {
    // 版本 0 表示新库。建表与版本号一并提交，后续版本由明确的迁移步骤处理。
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 1) return;
    if (version !== 0) knowledgeError(503, "知识库数据库版本不受支持。");
    db.exec(schema);
    db.exec("PRAGMA user_version = 1");
  });
}

// 公用目录库保存世界观编号和名称，以及已经确认发布的作品快照。
const catalogSchema = `
  CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE publications (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
    body TEXT NOT NULL, coverUrl TEXT NOT NULL, status TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
`;

// 每个世界观单独建这四张表：文章、文章间的关系、Agent 凭据、全文搜索切片。
// 关系的两端都引用本库文章。FTS5 以连续三个字符建立正文与章节索引。
const worldSchema = `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
    source TEXT NOT NULL, wikiId TEXT NOT NULL, revision INTEGER NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE relations (
    id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES documents(id), targetId TEXT NOT NULL REFERENCES documents(id),
    label TEXT NOT NULL, UNIQUE(sourceId, targetId, label), CHECK(sourceId <> targetId)
  );
  CREATE INDEX relations_target ON relations(targetId);
  CREATE TABLE tokens (id TEXT PRIMARY KEY, label TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
  CREATE VIRTUAL TABLE chunks USING fts5(documentId UNINDEXED, heading, body, tokenize='trigram');
`;

const summaryColumns = "id, title, kind, wikiId, revision, updatedAt";

// 给检索准备可引用的小段文本。每段都携带最近的章节标题，完整原稿另存于文章表。
function splitMarkdown(body: string) {
  const chunks: Array<{ heading: string; body: string }> = [];
  let heading = "";
  let buffer = "";
  let fence: { marker: string; length: number } | undefined;

  function flush() {
    if (buffer.trim()) chunks.push({ heading, body: buffer.trim() });
    buffer = "";
  }

  for (const line of body.split(/\r?\n/)) {
    // 记录 Markdown 代码围栏，让代码里的 # 保持为正文。遇到真正的标题时结束上一段。
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const headingLine = !fence && line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingLine) {
      flush();
      heading = headingLine[1];
    } else {
      if (marker) {
        if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      }
      if (buffer.length >= 900 && !line.trim() && !fence) flush();
      // 优先在空行切分。导入资料可能整段没有换行，因此也为单行和切片设置长度上限。
      for (const part of line.match(/[\s\S]{1,1400}/gu) ?? [""]) {
        if (buffer.length + part.length > 1800) flush();
        buffer += part + "\n";
      }
    }
  }
  flush();
  // 正文为空时保留一条索引记录，标题和来源仍然可以被搜到。
  return chunks.length ? chunks : [{ heading, body: "" }];
}

function documentFields(data: Record<string, unknown>) {
  const title = field(data.title, 160, true).trim();
  const kind = data.kind as DocumentKind;
  if (!documentKinds.includes(kind)) knowledgeError(400, "文章类型无效。");
  const body = field(data.body, 200_000);
  const source = field(data.source ?? "", 500).trim();
  // Wiki 绑定只存条目编号，参加检索的内容来自正文。
  const wikiId = field(data.wikiId ?? "", 120).trim();
  if (wikiId && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(wikiId)) knowledgeError(400, "Wiki 条目 ID 无效。");
  return { title, kind, body, source, wikiId };
}

function indexChunks(db: DatabaseSync, documentId: string, chunks: ReturnType<typeof splitMarkdown>) {
  const insert = db.prepare("INSERT INTO chunks(documentId, heading, body) VALUES (?, ?, ?)");
  for (const chunk of chunks) insert.run(documentId, chunk.heading, chunk.body);
}

export class KnowledgeStore {
  private readonly catalog: DatabaseSync;
  private readonly worldsDir: string;

  constructor(root: string) {
    this.worldsDir = join(root, "worlds");
    mkdirSync(this.worldsDir, { mode: 0o700, recursive: true });
    const file = join(root, "catalog.sqlite");
    this.catalog = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      prepareDatabase(this.catalog, catalogSchema);
    } catch (error) {
      this.catalog.close();
      throw error;
    }
  }

  close() {
    this.catalog.close();
  }

  private world(id: string): World {
    if (!/^[a-f0-9]{32}$/.test(id)) knowledgeError(404, "世界观不存在。");
    const world = this.catalog.prepare("SELECT id, name FROM worlds WHERE id = ?").get(id) as World | undefined;
    if (!world) knowledgeError(404, "世界观不存在。");
    return world;
  }

  private withWorld<T>(worldId: string, action: (db: DatabaseSync, world: World) => T): T {
    // 先用目录核对世界观，再按确认过的编号打开它的库。文章、关系和检索共用这一入口。
    const world = this.world(worldId);
    const file = join(this.worldsDir, `${world.id}.sqlite`);
    // SQLite 默认可以自动创建文件。发现现有世界观的库丢失时返回错误，保留异常现场。
    if (!existsSync(file)) knowledgeError(503, "世界观数据暂时不可用。");
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000");
      if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) knowledgeError(503, "世界观数据库版本不受支持。");
      return action(db, world);
    } finally {
      db.close();
    }
  }

  listWorlds() {
    return this.catalog.prepare("SELECT id, name FROM worlds ORDER BY name, id").all() as World[];
  }

  private registerWorld(name: string, populate?: (db: DatabaseSync) => void) {
    const world = { id: id(), name };
    const file = join(this.worldsDir, `${world.id}.sqlite`);
    const db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      prepareDatabase(db, worldSchema);
      populate?.(db);
      // 独立库初始化和导入全部成功后才在目录中登记。
      this.catalog.prepare("INSERT INTO worlds VALUES (?, ?)").run(world.id, world.name);
      return world;
    } finally {
      db.close();
    }
  }

  createWorld(input: unknown) {
    return this.registerWorld(field(record(input).name, 100, true).trim());
  }

  listDocuments(worldId: string) {
    return this.withWorld(worldId, (db) => db.prepare(`SELECT ${summaryColumns} FROM documents ORDER BY updatedAt DESC, id`).all() as DocumentSummary[]);
  }

  private document(db: DatabaseSync, documentId: string) {
    const item = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as Document | undefined;
    if (!item) knowledgeError(404, "文章不存在。");
    return item;
  }

  readDocument(worldId: string, documentId: string) {
    return this.withWorld(worldId, (db) => this.document(db, documentId));
  }

  saveDocument(worldId: string, input: unknown, documentId = id()) {
    const data = record(input);
    const { title, kind, body, source, wikiId } = documentFields(data);
    const chunks = splitMarkdown(body);

    return this.withWorld(worldId, (db) => transaction(db, () => {
      // revision 是编辑时读到的修订号。两人同时从同一版保存时，后一次会收到 409。
      const previous = db.prepare("SELECT revision FROM documents WHERE id = ?").get(documentId)?.revision;
      if (data.revision !== undefined && previous === undefined) knowledgeError(404, "文章不存在。");
      if (data.revision !== previous) knowledgeError(409, "文章已有新版本，本地修改已保留。");
      const revision = Number(previous ?? 0) + 1;
      const updatedAt = new Date().toISOString();
      if (previous === undefined) {
        db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(documentId, title, kind, body, source, wikiId, revision, updatedAt);
      } else {
        db.prepare("UPDATE documents SET title = ?, kind = ?, body = ?, source = ?, wikiId = ?, revision = ?, updatedAt = ? WHERE id = ?")
          .run(title, kind, body, source, wikiId, revision, updatedAt, documentId);
        db.prepare("DELETE FROM chunks WHERE documentId = ?").run(documentId);
      }
      // 文章和切片在同一次事务提交。检索结果随正文版本一并更新。
      indexChunks(db, documentId, chunks);
      return { id: documentId, title, kind, body, source, wikiId, revision, updatedAt };
    }));
  }

  search(worldId: string, input: unknown) {
    const data = record(input);
    const query = field(data.query, 120, true).trim();
    const limit = data.limit ?? 12;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 25) knowledgeError(400, "检索条数须在 1 到 25 之间。");
    return this.withWorld(worldId, (db) => {
      // 检索返回可引用的片段，并附上原文章号、修订号、章节和手填出处。
      const fields = "c.rowid AS chunkId, d.id AS documentId, d.title, d.kind, d.revision, d.source, d.wikiId, c.heading, c.body AS excerpt";
      // 三字符索引无法命中一两字的名字。短词在本世界观内直接查找子串。
      if ([...query].length < 3) {
        return db.prepare(`SELECT ${fields} FROM chunks c JOIN documents d ON d.id = c.documentId
          WHERE instr(d.title, ?) > 0 OR instr(d.source, ?) > 0 OR instr(c.heading, ?) > 0 OR instr(c.body, ?) > 0
          ORDER BY (instr(d.title, ?) > 0) DESC, c.rowid LIMIT ?`).all(query, query, query, query, query, limit);
      }
      // 把关键词作为字面短语交给 FTS5，用户输入的引号也按普通字符处理。
      const escaped = `"${query.replaceAll('"', '""')}"`;
      return db.prepare(`SELECT ${fields} FROM chunks c JOIN documents d ON d.id = c.documentId
        WHERE c.rowid IN (SELECT rowid FROM chunks WHERE chunks MATCH ?) OR instr(d.title, ?) > 0 OR instr(d.source, ?) > 0
        ORDER BY (instr(d.title, ?) > 0) DESC, (instr(c.body, ?) > 0) DESC, c.rowid LIMIT ?`)
        .all(escaped, query, query, query, query, limit);
    });
  }

  private relations(db: DatabaseSync) {
    return db.prepare("SELECT id, sourceId, targetId, label FROM relations ORDER BY label, id").all() as Relation[];
  }

  graph(worldId: string) {
    // 每篇文章对应一个节点，文章关系对应有向连线。切片数量供索引看板显示。
    return this.withWorld(worldId, (db) => ({
      nodes: db.prepare(`SELECT ${summaryColumns}, COALESCE(counts.chunkCount, 0) AS chunkCount
        FROM documents LEFT JOIN (SELECT documentId, count(*) AS chunkCount FROM chunks GROUP BY documentId) counts
        ON counts.documentId = documents.id ORDER BY kind, title, id`).all(),
      edges: this.relations(db)
    }));
  }

  addRelation(worldId: string, input: unknown) {
    const data = record(input);
    const relation = { id: id(), sourceId: field(data.sourceId, 32, true), targetId: field(data.targetId, 32, true), label: field(data.label, 50, true).trim() };
    if (relation.sourceId === relation.targetId) knowledgeError(400, "请选择另一篇文章。");
    return this.withWorld(worldId, (db) => {
      // 两端都必须能在当前世界观找到。其他世界观的文章编号在本库查找会失败。
      this.document(db, relation.sourceId);
      this.document(db, relation.targetId);
      const result = db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?) ON CONFLICT(sourceId, targetId, label) DO NOTHING")
        .run(relation.id, relation.sourceId, relation.targetId, relation.label);
      if (!result.changes) knowledgeError(409, "这条关系已存在。");
      return relation;
    });
  }

  removeRelation(worldId: string, relationId: string) {
    return this.withWorld(worldId, (db) => {
      db.prepare("DELETE FROM relations WHERE id = ?").run(relationId);
      return { ok: true };
    });
  }

  listTokens(worldId: string) {
    return this.withWorld(worldId, (db) => db.prepare("SELECT id, label, scope FROM tokens ORDER BY label, id").all() as Token[]);
  }

  createToken(worldId: string, input: unknown) {
    const data = record(input);
    const label = field(data.label, 80, true).trim();
    const scope = data.scope;
    if (scope !== "read" && scope !== "write") knowledgeError(400, "凭据权限无效。");
    const token = `rag_${randomBytes(32).toString("hex")}`;
    const tokenId = id();
    return this.withWorld(worldId, (db) => {
      db.prepare("INSERT INTO tokens VALUES (?, ?, ?, ?)").run(tokenId, label, scope, digest(token));
      // 明文凭据只在签发时随响应返回，后续列表从库中读取名称、编号和权限。
      return { id: tokenId, label, scope, token };
    });
  }

  revokeToken(worldId: string, tokenId: string) {
    return this.withWorld(worldId, (db) => {
      db.prepare("DELETE FROM tokens WHERE id = ?").run(tokenId);
      return { ok: true };
    });
  }

  tokenScope(worldId: string, authorization: string | undefined) {
    // 只到请求指定的世界观核对凭据指纹。撤销会删除匹配记录。
    const token = authorization?.match(/^Bearer (rag_[a-f0-9]{64})$/i)?.[1];
    if (!token || !this.catalog.prepare("SELECT 1 FROM worlds WHERE id = ?").get(worldId)) return undefined;
    return this.withWorld(worldId, (db) => db.prepare("SELECT scope FROM tokens WHERE hash = ?").get(digest(token))?.scope);
  }

  exportWorld(worldId: string) {
    // 供维护者带走当前世界观的文章和关系。完整恢复所需的库文件由运维备份。
    return this.withWorld(worldId, (db, world) => transaction(db, () => ({
      version: 1,
      world,
      documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
      relations: this.relations(db)
    })));
  }

  importWorld(input: unknown) {
    const data = record(input);
    const backup = record(data.backup);
    if (backup.version !== 1 || !Array.isArray(backup.documents) || !Array.isArray(backup.relations)) {
      knowledgeError(400, "请选择版本为 1 的世界观备份。");
    }
    const originalName = field(record(backup.world).name, 100, true).trim();
    const name = field(data.name ?? originalName, 100, true).trim();
    const documentIds = new Map<string, string>();
    const documents = backup.documents.map((entry: unknown) => {
      const inputDocument = record(entry);
      const sourceId = field(inputDocument.id, 32, true);
      if (!/^[a-f0-9]{32}$/.test(sourceId) || documentIds.has(sourceId)) {
        knowledgeError(400, "备份存在无效或重复的文章编号。");
      }
      const revision = inputDocument.revision;
      const updatedAt = field(inputDocument.updatedAt, 50, true);
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(Date.parse(updatedAt))) {
        knowledgeError(400, "备份中的文章版本或时间无效。");
      }
      const documentId = id();
      documentIds.set(sourceId, documentId);
      return { id: documentId, ...documentFields(inputDocument), revision, updatedAt };
    });
    const relationKeys = new Set<string>();
    const relations = backup.relations.map((entry: unknown) => {
      const relation = record(entry);
      const sourceId = documentIds.get(field(relation.sourceId, 32, true));
      const targetId = documentIds.get(field(relation.targetId, 32, true));
      const label = field(relation.label, 50, true).trim();
      if (!sourceId || !targetId || sourceId === targetId) knowledgeError(400, "备份中有关系指向不存在或相同的文章。");
      const relationKey = JSON.stringify([sourceId, targetId, label]);
      if (relationKeys.has(relationKey)) knowledgeError(400, "备份中有重复的文章关系。");
      relationKeys.add(relationKey);
      return { id: id(), sourceId, targetId, label };
    });

    return transaction(this.catalog, () => {
      if (this.catalog.prepare("SELECT 1 FROM worlds WHERE name = ?").get(name)) {
        knowledgeError(409, "世界观名称已存在。请给导入的副本使用其他名称。");
      }
      // 从原稿重建索引，只向新库写入，现有世界观和公开作品不受影响。
      return this.registerWorld(name, (db) => transaction(db, () => {
        const insertDocument = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const doc of documents) {
          insertDocument.run(doc.id, doc.title, doc.kind, doc.body, doc.source, doc.wikiId, doc.revision, doc.updatedAt);
          indexChunks(db, doc.id, splitMarkdown(doc.body));
        }
        const insertRelation = db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?)");
        for (const edge of relations) insertRelation.run(edge.id, edge.sourceId, edge.targetId, edge.label);
      }));
    });
  }

  getPublication(documentId: string) {
    // 作品页通过稳定的 kb- 编号读取已发布快照。公开详情只选取作品展示字段。
    return this.catalog.prepare("SELECT id, kind, title, summary, body, coverUrl, status, updatedAt FROM publications WHERE id = ?")
      .get(`kb-${documentId}`) as Publication | undefined;
  }

  listPublications() {
    // 列表只需要标题、摘要等卡片字段。正文由详情接口按需读取。
    return this.catalog.prepare("SELECT id, kind, title, summary, coverUrl, status, updatedAt FROM publications ORDER BY updatedAt DESC, id")
      .all() as Array<Omit<Publication, "body">>;
  }

  publicationFor(worldId: string, documentId: string) {
    // 维护者从世界观打开公开版时，先确认原文章属于这个世界观。
    this.readDocument(worldId, documentId);
    return this.getPublication(documentId) ?? null;
  }

  publish(worldId: string, documentId: string, input: unknown) {
    // 公开稿由维护者单独确认。这里只接收明确提交的标题、摘要、正文和封面。
    const data = record(input);
    const title = field(data.title, 160, true).trim();
    const summary = field(data.summary, 300).trim();
    const body = field(data.body, 200_000, true);
    const coverUrl = field(data.coverUrl ?? "", 1000).trim();
    // 拦截已知的秘密标记和私有路由。公开前仍由预览环节检查实际正文。
    if ([title, summary, body].some((part) => /【\/?加密(?:字|块)】|\/workbench\/knowledge|\/api\/knowledge|\bsecret-(?:inline|panel)\b/i.test(part))) {
      knowledgeError(400, "公开稿含有秘密标记或私有知识库链接。");
    }
    if (coverUrl && !/^(\/content-assets\/[^\s]+|https:\/\/[^\s]+)$/i.test(coverUrl)) knowledgeError(400, "封面须使用公开素材地址或 HTTPS 链接。");
    if (/\/workbench\/knowledge|\/api\/knowledge/i.test(coverUrl)) knowledgeError(400, "封面须使用公开素材地址。");

    return this.withWorld(worldId, (db) => transaction(db, () => {
      // 发布期间锁住原稿修订。目录库随后核对预览时读到的公开版本，再写新快照。
      const document = this.document(db, documentId);
      if (document.revision !== data.revision) knowledgeError(409, "原稿版本已更新，请重新检查公开稿。");
      return transaction(this.catalog, () => {
        const existing = this.getPublication(documentId);
        if ((existing?.updatedAt ?? null) !== data.previousPublicationAt) knowledgeError(409, "公开版已更新，请重新载入后再发布。");
        const kind = document.kind === "module" ? "module" : "setting";
        const timestamp = existing ? Math.max(Date.now(), Date.parse(existing.updatedAt) + 1) : Date.now();
        const publication: Publication = { id: `kb-${documentId}`, kind, title, summary, body, coverUrl, status: "published", updatedAt: new Date(timestamp).toISOString() };
        this.catalog.prepare(`INSERT INTO publications VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, summary = excluded.summary,
          body = excluded.body, coverUrl = excluded.coverUrl, updatedAt = excluded.updatedAt`)
          .run(publication.id, kind, title, summary, body, coverUrl, publication.status, publication.updatedAt);
        return publication;
      });
    }));
  }

  unpublish(worldId: string, documentId: string, input: unknown) {
    const data = record(input);
    this.readDocument(worldId, documentId);
    // 只撤下用户操作时读到的公开版本，避免误撤下另一位维护者刚发布的更新。
    const result = this.catalog.prepare("DELETE FROM publications WHERE id = ? AND updatedAt = ?")
      .run(`kb-${documentId}`, field(data.previousPublicationAt, 50, true));
    if (!result.changes) knowledgeError(409, "公开版已变化，请重新载入。");
    return { ok: true };
  }
}
