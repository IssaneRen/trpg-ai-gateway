import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

async function copyDatabase(from, to) {
  const source = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(source, to);
  } finally {
    source.close();
  }
  await chmod(to, 0o600);
  const copy = new DatabaseSync(to, { readOnly: true });
  try {
    if (copy.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
      throw new Error("SQLite 备份完整性检查失败。");
    }
  } finally {
    copy.close();
  }
}

async function backupKnowledge(source, destination) {
  if (!source || !destination) {
    throw new Error("用法：node scripts/backup-knowledge.mjs <知识库目录> <备份目录>");
  }
  const root = resolve(source);
  const archive = resolve(destination);
  const catalog = join(root, "catalog.sqlite");
  try {
    await stat(catalog);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("知识库尚未初始化，无数据需要备份。");
    return;
  }
  await mkdir(archive, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(archive, ".knowledge-"));
  try {
    await mkdir(join(stage, "worlds"), { mode: 0o700 });
    const privateCatalog = join(stage, "catalog.sqlite");
    // 从已备份的目录确定世界观范围。每个库使用 SQLite 在线备份，包含已提交的日志内容。
    await copyDatabase(catalog, privateCatalog);
    const index = new DatabaseSync(privateCatalog, { readOnly: true });
    let worlds;
    try {
      worlds = index.prepare("SELECT id FROM worlds ORDER BY id").all();
    } finally {
      index.close();
    }
    for (const { id } of worlds) {
      if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) {
        throw new Error("知识库目录包含无效的世界观编号。");
      }
      const child = join("worlds", `${id}.sqlite`);
      await copyDatabase(join(root, child), join(stage, child));
    }
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const snapshot = `knowledge-${timestamp}-${basename(stage).slice(".knowledge-".length)}`;
    await rename(stage, join(archive, snapshot));
    console.log(`知识库备份已验证：${snapshot}（${worlds.length} 个世界观）。`);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

process.umask(0o077);
try {
  await backupKnowledge(...process.argv.slice(2));
} catch (error) {
  console.error("知识库备份失败：", error.message);
  process.exitCode = 1;
}
