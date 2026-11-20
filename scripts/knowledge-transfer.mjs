import {
  createDecipheriv, createHash, createPrivateKey, generateKeyPairSync, privateDecrypt,
} from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeStore } from "../dist/knowledge/knowledge-store.js";

process.umask(0o077);
const keyLifetimeMs = 30 * 60 * 1000;
const [operation, root] = process.argv.slice(2);
if (!root) throw new Error("缺少知识库数据目录。");
const keyPath = join(root, ".transfer-key.pem");
const proofPath = join(root, ".transfer-proof.json");

function signature(backup) {
  // 恢复会换文章编号。用原稿字段和连线内容比较恢复前后是否一致。
  const articles = new Map(backup.documents.map((doc) => [
    doc.id, JSON.stringify([doc.title, doc.kind, doc.body, doc.source, doc.wikiId, doc.revision, doc.updatedAt]),
  ]));
  const documents = [...articles.values()].sort();
  const relations = backup.relations.map((edge) => JSON.stringify([
    articles.get(edge.sourceId), articles.get(edge.targetId), edge.label,
  ])).sort();
  return createHash("sha256").update(JSON.stringify({ documents, relations })).digest("hex");
}

async function prepare() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  // 发布日志只输出供发送方加密的公钥。私钥由生产服务用户保管。
  console.log("KNOWLEDGE_TRANSFER_PUBLIC_KEY=" + publicKey.export({ type: "spki", format: "der" }).toString("base64"));
}

async function readEnvelope() {
  const envelope = process.env.KNOWLEDGE_TRANSFER_ENVELOPE;
  if (!envelope) throw new Error("缺少加密传输包。");
  if (Date.now() - (await stat(keyPath)).mtimeMs > keyLifetimeMs) {
    throw new Error("传输公钥已过期，请重新准备。");
  }
  const { key, iv, tag, data } = JSON.parse(Buffer.from(envelope, "base64").toString("utf8"));
  const privateKey = createPrivateKey(await readFile(keyPath));
  const symmetricKey = privateDecrypt({ key: privateKey, oaepHash: "sha256" }, Buffer.from(key, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", symmetricKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  const payload = JSON.parse(plaintext.toString("utf8"));
  if (payload.version !== 1 || !Array.isArray(payload.backups) || !payload.backups.length) {
    throw new Error("传输包格式无效。");
  }
  return payload.backups;
}

async function verify(store) {
  const expected = JSON.parse(await readFile(proofPath, "utf8"));
  let checkedDocuments = 0;
  for (const entry of expected) {
    const data = store.exportWorld(entry.id);
    if (signature(data) !== entry.signature) throw new Error("恢复前后世界观内容有差异。");
    checkedDocuments += data.documents.length;
    if (data.documents.length === 0) continue;

    const doc = data.documents[0];
    const token = store.createToken(entry.id, { label: "发布检索验收", scope: "read" });
    try {
      const port = process.env.KNOWLEDGE_VERIFY_PORT ?? "3001";
      if (!/^\d{1,5}$/.test(port)) throw new Error("检索验收端口无效。");
      const url = `http://127.0.0.1:${port}/api/knowledge/worlds/${entry.id}/search`;
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: [...doc.title].slice(0, 3).join(""), limit: 25 }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || !(await response.json()).some((item) => item.documentId === doc.id)) {
        throw new Error("恢复后的世界观检索验证失败。");
      }
    } finally {
      store.revokeToken(entry.id, token.id);
    }
  }
  console.log(`已验证 ${expected.length} 个私有世界观、${checkedDocuments} 张卡与检索。`);
}

async function importBackups(store) {
  const backups = await readEnvelope();
  const names = new Set();
  const worlds = store.listWorlds();
  const plan = backups.map((backup) => {
    const name = backup.world.name;
    if (typeof name !== "string" || !name.trim() || names.has(name)) {
      throw new Error("传输包存在无效或重复的世界观名称。");
    }
    names.add(name);
    const matches = worlds.filter((world) => world.name === name);
    const digest = signature(backup);
    if (matches.length > 1 || (matches.length === 1 && signature(store.exportWorld(matches[0].id)) !== digest)) {
      throw new Error("生产环境有同名且不同内容的世界观，请在维护者界面核对。");
    }
    return { existing: matches[0], backup, digest };
  });
  const proof = plan.map(({ existing, backup, digest }) => ({
    id: (existing ?? store.importWorld({ backup })).id,
    signature: digest,
  }));
  await writeFile(proofPath, JSON.stringify(proof) + "\n", { mode: 0o600 });
  await verify(store);
  await unlink(keyPath);
}

try {
  if (operation === "prepare") {
    await prepare();
  } else if (operation === "import" || operation === "verify") {
    const store = new KnowledgeStore(root);
    try {
      if (operation === "import") await importBackups(store);
      else await verify(store);
    } finally {
      store.close();
    }
  } else {
    throw new Error("不支持的知识库运维操作。");
  }
} catch (error) {
  console.error("知识库运维操作失败。", error instanceof Error && "statusCode" in error ? error.message : error?.name ?? "Error");
  process.exitCode = 1;
}
