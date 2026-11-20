import type { IncomingMessage } from "node:http";
import { knowledgeError, type KnowledgeStore } from "./knowledge-store.js";

type RouteContext = {
  store: KnowledgeStore;
  request: IncomingMessage;
  pathname: string;
  keeper: boolean;
  json: () => Promise<unknown>;
  send: (status: number, body: unknown) => void;
};

export async function routeKnowledge({ store, request, pathname, keeper, json, send }: RouteContext) {
  const method = request.method;
  const base = "/api/knowledge/worlds";
  const scoped = pathname.match(/^\/api\/knowledge\/worlds\/([a-f0-9]{32})(?:\/(.*))?$/);
  if (pathname === base) {
    // 世界观总目录只供维护者查看和新建。Agent 从指定世界观的地址进入。
    if (!keeper) knowledgeError(403, "需要维护者权限。");
    if (method === "GET") return send(200, store.listWorlds());
    if (method === "POST") return send(201, store.createWorld(await json()));
  }
  if (pathname === `${base}/import` && method === "POST") {
    if (!keeper) knowledgeError(403, "需要维护者权限。");
    return send(201, store.importWorld(await json()));
  }

  if (!scoped) knowledgeError(404, "知识库接口不存在。");
  const [, world, action] = scoped;
  // world 是地址中的世界观编号。Agent 的权限由该世界观自己的库给出。
  const scope = keeper ? "write" : store.tokenScope(world, request.headers.authorization);
  if (!scope) knowledgeError(403, "此凭据无法访问该世界观。");

  // 搜索虽然用 POST 传关键词，仍属于读权限。读权限也可查看关系图及文章。
  if (action === "search" && method === "POST") return send(200, store.search(world, await json()));
  if (action === "graph" && method === "GET") return send(200, store.graph(world));
  if (action === "documents" && method === "GET") return send(200, store.listDocuments(world));
  const document = action?.match(/^documents\/([a-f0-9]{32})$/)?.[1];
  if (document && method === "GET") return send(200, store.readDocument(world, document));

  // 读写凭据可以保存文章和维护关系。保存后的 HTTP 状态用 201 表示新建，200 表示更新。
  if (scope !== "write") knowledgeError(403, "此操作需要写入权限。");
  if (action === "documents" && method === "POST") return send(201, store.saveDocument(world, await json()));
  if (document && method === "PUT") return send(200, store.saveDocument(world, await json(), document));
  if (action === "relations" && method === "POST") return send(201, store.addRelation(world, await json()));
  const relation = action?.match(/^relations\/([a-f0-9]{32})$/)?.[1];
  if (relation && method === "DELETE") return send(200, store.removeRelation(world, relation));

  // 整库导出、凭据管理、发布及撤回都要求维护者身份。
  if (!keeper) knowledgeError(403, "此操作仅限维护者。");
  if (action === "export" && method === "GET") return send(200, store.exportWorld(world));
  if (action === "tokens" && method === "GET") return send(200, store.listTokens(world));
  if (action === "tokens" && method === "POST") return send(201, store.createToken(world, await json()));
  const token = action?.match(/^tokens\/([a-f0-9]{32})$/)?.[1];
  if (token && method === "DELETE") return send(200, store.revokeToken(world, token));

  const publication = action?.match(/^documents\/([a-f0-9]{32})\/publication$/)?.[1];
  if (publication && method === "GET") return send(200, store.publicationFor(world, publication));
  if (publication && method === "PUT") return send(200, store.publish(world, publication, await json()));
  if (publication && method === "DELETE") return send(200, store.unpublish(world, publication, await json()));

  knowledgeError(404, "知识库接口不存在。");
}
