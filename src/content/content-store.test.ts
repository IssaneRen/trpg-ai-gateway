import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { ContentStore } from "./content-store.js";

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "trpg-content-store-"));
  const contentRootDir = join(root, "content");
  const uploadRootDir = join(root, "uploads");
  mkdirSync(join(contentRootDir, "blog", "posts"), { recursive: true });
  mkdirSync(join(contentRootDir, "wiki", "entities", "entries"), { recursive: true });
  mkdirSync(uploadRootDir, { recursive: true });
  writeFileSync(join(contentRootDir, "blog", "index.json"), "[]\n");
  writeFileSync(join(contentRootDir, "wiki", "entities", "players.json"), "[]\n");
  writeFileSync(join(contentRootDir, "wiki", "entities", "modules.json"), "[]\n");
  writeFileSync(
    join(contentRootDir, "wiki", "index.json"),
    JSON.stringify({ players: [], modules: [], entries: [], lookup: { entryIdByName: {}, playerIdByName: {}, moduleIdByName: {} } })
  );
  return {
    root,
    contentRootDir,
    uploadRootDir,
    store: new ContentStore({
      contentRootDir,
      uploadRootDir,
      publicUploadBaseUrl: "/content-assets",
      maxUploadBytes: 1024,
      maxImportBytes: 1024 * 1024
    })
  };
}

function exampleWikiEntry(id = "loc.test") {
  return {
    id,
    category: "location",
    displayName: "测试地点",
    summary: "用于测试的地点。",
    aliasNames: ["测试别名"],
    playerIds: [],
    moduleIds: [],
    relatedEntryIds: [],
    facts: [],
    content: [
      { type: "paragraph", tokens: [{ type: "text", text: "公开文字", bold: true }] },
      {
        type: "secret-panel",
        title: "隐藏档案",
        hiddenMode: "mask",
        playerIds: [],
        blocks: [{ type: "paragraph", tokens: [{ type: "secret-inline", playerIds: [], text: "秘密" }] }]
      }
    ],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  };
}

describe("ContentStore", () => {
  it("saves a blog document and regenerates the public index", async () => {
    const fixture = createStore();
    await fixture.store.saveBlog({
      id: "keeper-notes",
      title: "守秘人笔记",
      tags: ["博客", "笔记"],
      cover: ["/content-assets/cover.png"],
      players: ["pl.cici"],
      renderMode: "markdown",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T01:00:00.000Z",
      markdown: "# 第一章\n\n正文。"
    });

    const loaded = await fixture.store.readBlog("keeper-notes");
    expect(loaded.markdown).toBe("# 第一章\n\n正文。\n");
    expect(loaded.cover).toEqual(["/content-assets/cover.png"]);
    const index = JSON.parse(readFileSync(join(fixture.contentRootDir, "blog", "index.json"), "utf-8"));
    expect(index).toEqual([
      expect.objectContaining({
        id: "keeper-notes",
        title: "守秘人笔记",
        file: "posts/keeper-notes.md",
        tags: ["博客", "笔记"]
      })
    ]);
  });

  it("preserves every Wiki block field and rebuilds lookup data", async () => {
    const fixture = createStore();
    const entry = exampleWikiEntry();
    await fixture.store.saveWiki(entry);

    expect(await fixture.store.readWiki("loc.test")).toEqual(entry);
    const index = JSON.parse(readFileSync(join(fixture.contentRootDir, "wiki", "index.json"), "utf-8"));
    expect(index.entries[0]).toMatchObject({ id: "loc.test", displayName: "测试地点" });
    expect(index.lookup.entryIdByName).toEqual({ "loc.test": "loc.test", "测试地点": "loc.test", "测试别名": "loc.test" });
  });

  it("does not publish a Wiki file when index validation fails", async () => {
    const fixture = createStore();
    await fixture.store.saveWiki({ ...exampleWikiEntry("loc.first"), displayName: "重复名称" });
    const indexBefore = readFileSync(join(fixture.contentRootDir, "wiki", "index.json"), "utf-8");

    await expect(
      fixture.store.saveWiki({ ...exampleWikiEntry("loc.second"), displayName: "重复名称" })
    ).rejects.toThrow("冲突");

    expect(existsSync(join(fixture.contentRootDir, "wiki", "entities", "entries", "loc.second.json"))).toBe(false);
    expect(readFileSync(join(fixture.contentRootDir, "wiki", "index.json"), "utf-8")).toBe(indexBefore);
  });

  it("rejects unsafe ids before writing files", async () => {
    const fixture = createStore();
    await expect(fixture.store.saveWiki(exampleWikiEntry("../escape"))).rejects.toThrow("不安全");
    await expect(fixture.store.readBlog("../../escape")).rejects.toThrow("不安全");
  });

  it("stores an image under the configured upload root with a public URL", async () => {
    const fixture = createStore();
    const result = await fixture.store.saveImage({
      fileName: "封面 图.PNG",
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71])
    });

    expect(result.url).toMatch(/^\/content-assets\/\d{4}\/\d{2}\/cover-[a-f0-9-]+\.png$/);
    expect(readFileSync(result.absolutePath)).toEqual(Buffer.from([137, 80, 78, 71]));
    await expect(
      fixture.store.saveImage({ fileName: "note.txt", mimeType: "text/plain", bytes: strToU8("x") })
    ).rejects.toThrow("图片");
  });

  it("exports and imports the versioned ZIP layout", async () => {
    const source = createStore();
    await source.store.saveBlog({
      id: "backup-post",
      title: "备份文章",
      tags: [],
      renderMode: "markdown",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      markdown: "备份正文"
    });
    await source.store.saveWiki(exampleWikiEntry());
    const archive = await source.store.exportZip();

    const target = createStore();
    const result = await target.store.importZip(archive);
    expect(result).toMatchObject({ blogPosts: 1, wikiEntries: 1 });
    expect((await target.store.readBlog("backup-post")).title).toBe("备份文章");
    expect((await target.store.readWiki("loc.test")).content[1]).toMatchObject({
      type: "secret-panel",
      hiddenMode: "mask"
    });
  });

  it("rejects traversal, unknown roots, invalid manifests, and invalid JSON before import", async () => {
    const fixture = createStore();
    for (const archive of [
      zipSync({ "../escape.txt": strToU8("bad") }),
      zipSync({ "manifest.json": strToU8('{"formatVersion":1}'), "unknown/file.txt": strToU8("bad") }),
      zipSync({ "manifest.json": strToU8('{"formatVersion":2}') }),
      zipSync({ "manifest.json": strToU8('{"formatVersion":1}'), "wiki/index.json": strToU8("not-json") })
    ]) {
      await expect(fixture.store.importZip(archive)).rejects.toThrow();
    }
  });

  it("rejects unsupported files and invalid content schemas before switching directories", async () => {
    const fixture = createStore();
    const base = {
      "manifest.json": strToU8('{"formatVersion":1}'),
      "blog/index.json": strToU8("[]"),
      "wiki/index.json": strToU8("{}"),
      "wiki/entities/players.json": strToU8("[]"),
      "wiki/entities/modules.json": strToU8("[]")
    };
    await expect(
      fixture.store.importZip(zipSync({ ...base, "uploads/session.html": strToU8("<script />") }))
    ).rejects.toThrow("不支持的文件");
    await expect(
      fixture.store.importZip(
        zipSync({ ...base, "wiki/entities/players.json": strToU8("{}") })
      )
    ).rejects.toThrow("必须是数组");
  });

  it("rejects oversized declared ZIP content before inflation", async () => {
    const fixture = createStore();
    const archive = zipSync({ "manifest.json": strToU8('{"formatVersion":1}') });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let centralDirectory = -1;
    for (let offset = 0; offset <= archive.byteLength - 4; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        centralDirectory = offset;
        break;
      }
    }
    expect(centralDirectory).toBeGreaterThanOrEqual(0);
    view.setUint32(centralDirectory + 24, 2 * 1024 * 1024, true);
    await expect(fixture.store.importZip(archive)).rejects.toThrow("解压后大小超出限制");
  });
});
