import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuthSession } from "../auth/tokens.js";
import { reject } from "../auth/accounts.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: Json };

function secret(node: Node) {
  return node.type === "secret-inline" || node.type === "secret-panel";
}
function allowed(node: Node, session?: AuthSession) {
  return (
    !!session &&
    (session.isKeeper ||
      (Array.isArray(node.playerIds) &&
        node.playerIds.includes(session.playerId)))
  );
}
export function redact(value: Json, session?: AuthSession): Json {
  if (Array.isArray(value)) return value.map((item) => redact(item, session));
  if (!value || typeof value !== "object") return value;
  if (secret(value) && !allowed(value, session)) {
    return value.type === "secret-inline"
      ? { type: value.type, text: "•••" }
      : {
          type: value.type,
          hiddenMode: value.hiddenMode === "collapse" ? "collapse" : "mask",
          title: "加密段落",
          blocks: [],
        };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, redact(field, session)]),
  );
}
async function contents(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      reject(404, "资源不存在");
    throw error;
  }
}
export async function readReport(
  root: string,
  name: string,
  session?: AuthSession,
) {
  if (!/^report\.[a-z0-9._-]+\.json$/i.test(name)) reject(404, "资源不存在");
  const bytes = await contents(join(root, "wiki/entities/entries", name));
  return redact(JSON.parse(bytes.toString("utf8")), session);
}
export async function readReportImage(
  root: string,
  path: string,
  session?: AuthSession,
) {
  if (
    !/^\/blog\/images\/report-[a-z0-9_-]+\/[a-z0-9._-]+\.(png|jpe?g|webp|gif|avif)$/i.test(
      path,
    )
  )
    reject(404, "资源不存在");
  let referenced = false;
  let restricted = false;
  let granted = false;
  function inspect(value: Json, privateBlock: boolean, readable: boolean) {
    if (Array.isArray(value)) {
      value.forEach((child) => inspect(child, privateBlock, readable));
      return;
    }
    if (!value || typeof value !== "object") return;
    const locked = secret(value);
    const within = privateBlock || locked;
    const visible = readable && (!locked || allowed(value, session));
    if (value.src === path) referenced = true;
    if (within && value.src === path) {
      restricted = true;
      if (visible) granted = true;
    }
    Object.values(value).forEach((child) => inspect(child, within, visible));
  }
  const directory = join(root, "wiki/entities/entries");
  for (const name of await readdir(directory)) {
    if (/^report\..+\.json$/i.test(name)) {
      inspect(
        JSON.parse((await contents(join(directory, name))).toString("utf8")),
        false,
        true,
      );
    }
  }
  if (path.startsWith("/blog/images/report-uploads/") && !referenced && !session?.isKeeper) reject(404, "资源不存在");
  if (restricted && !granted) reject(session ? 403 : 401, "需要战报授权");
  return contents(join(root, path));
}
