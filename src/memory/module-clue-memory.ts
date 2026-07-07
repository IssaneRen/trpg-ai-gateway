import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertSafeSegment } from "./safe-path.js";

export interface ModuleClueRecord {
  id: string;
  title: string;
  summary?: string;
  detail?: string;
  tags: string[];
  thumbnail?: string;
  order: number;
  isInitial?: boolean;
  reveals: string[];
  revealReasons?: Record<string, string>;
}

export interface ModuleClueEdge {
  id: string;
  source: string;
  target: string;
  reason?: string;
}

export interface ModuleCluePayload {
  module: {
    id: string;
    name: string;
  };
  clues: Array<ModuleClueRecord & { visiblePlayerIds?: string[] }>;
  edges: ModuleClueEdge[];
  tags: string[];
  players?: Array<{ id: string; name: string }>;
}

export interface ModuleClueSummary {
  id: string;
  name: string;
}

interface ModuleClueFile {
  moduleId: string;
  moduleName: string;
  clues: ModuleClueRecord[];
}

interface ModuleClueVisibilityFile {
  version: number;
  clues: Record<string, string[]>;
}

export interface VisibilityUpdateBody {
  playerIds: string[];
}

function assertInsideRoot(rootDir: string, targetPath: string): string {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error("module clue path escaped root");
  }
  return target;
}

function moduleDir(rootDir: string, moduleId: string): string {
  const safeModuleId = assertSafeSegment(moduleId, "moduleId");
  return assertInsideRoot(rootDir, resolve(rootDir, safeModuleId));
}

function clueFilePath(rootDir: string, moduleId: string): string {
  return assertInsideRoot(rootDir, resolve(moduleDir(rootDir, moduleId), "clues.json"));
}

function visibilityFilePath(rootDir: string, moduleId: string): string {
  return assertInsideRoot(rootDir, resolve(moduleDir(rootDir, moduleId), "visibility.json"));
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const raw = requireObject(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    result[assertSafeSegment(key, label)] = requireString(item, `${label}.${key}`);
  }
  return result;
}

function normalizeClue(value: unknown): ModuleClueRecord {
  const clue = requireObject(value, "clue");
  const id = assertSafeSegment(requireString(clue.id, "clue.id"), "clue.id");
  const order = typeof clue.order === "number" && Number.isFinite(clue.order) ? clue.order : 0;
  return {
    id,
    title: requireString(clue.title, "clue.title"),
    summary: optionalString(clue.summary, "clue.summary"),
    detail: optionalString(clue.detail, "clue.detail"),
    tags: requireStringArray(clue.tags ?? [], "clue.tags"),
    thumbnail: optionalString(clue.thumbnail, "clue.thumbnail"),
    order,
    isInitial: clue.isInitial === true ? true : undefined,
    reveals: requireStringArray(clue.reveals ?? [], "clue.reveals").map((targetId) =>
      assertSafeSegment(targetId, "clue.reveals")
    ),
    revealReasons: optionalStringRecord(clue.revealReasons, "clue.revealReasons")
  };
}

function normalizeClueFile(value: unknown, requestedModuleId: string): ModuleClueFile {
  const file = requireObject(value, "module clue file");
  const moduleId = assertSafeSegment(requireString(file.moduleId, "moduleId"), "moduleId");
  if (moduleId !== requestedModuleId) throw new Error("moduleId does not match path");
  return {
    moduleId,
    moduleName: requireString(file.moduleName, "moduleName"),
    clues: Array.isArray(file.clues) ? file.clues.map(normalizeClue) : []
  };
}

function normalizeVisibilityFile(value: unknown): ModuleClueVisibilityFile {
  const file = requireObject(value, "visibility file");
  const rawClues = requireObject(file.clues ?? {}, "visibility.clues");
  const clues: Record<string, string[]> = {};
  for (const [clueId, playerIds] of Object.entries(rawClues)) {
    clues[assertSafeSegment(clueId, "clueId")] = requireStringArray(playerIds, "visiblePlayerIds").map((playerId) =>
      assertSafeSegment(playerId, "playerId")
    );
  }
  return {
    version: typeof file.version === "number" && Number.isFinite(file.version) ? file.version : 1,
    clues
  };
}

async function readModuleClueFile(rootDir: string, moduleId: string): Promise<ModuleClueFile> {
  const safeModuleId = assertSafeSegment(moduleId, "moduleId");
  const parsed = JSON.parse(await readFile(clueFilePath(rootDir, safeModuleId), "utf-8"));
  return normalizeClueFile(parsed, safeModuleId);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readVisibilityFile(rootDir: string, moduleId: string): Promise<ModuleClueVisibilityFile> {
  try {
    return normalizeVisibilityFile(
      JSON.parse(await readFile(visibilityFilePath(rootDir, moduleId), "utf-8"))
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return { version: 1, clues: {} };
    }
    throw error;
  }
}

function compareClues(left: ModuleClueRecord, right: ModuleClueRecord): number {
  return left.order - right.order || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function buildEdges(clues: ModuleClueRecord[]): ModuleClueEdge[] {
  const clueIds = new Set(clues.map((clue) => clue.id));
  return clues.flatMap((clue) =>
    clue.reveals
      .filter((targetId) => clueIds.has(targetId))
      .map((targetId) => ({
        id: `${clue.id}->${targetId}`,
        source: clue.id,
        target: targetId,
        reason: clue.revealReasons?.[targetId]
      }))
  );
}

function deriveTags(clues: ModuleClueRecord[]): string[] {
  const tags = new Set<string>();
  for (const clue of clues) {
    for (const tag of clue.tags) tags.add(tag);
  }
  return Array.from(tags);
}

function filterClueLinks(clue: ModuleClueRecord, visibleClueIds: Set<string>): ModuleClueRecord {
  const reveals = clue.reveals.filter((targetId) => visibleClueIds.has(targetId));
  const revealReasons = clue.revealReasons
    ? Object.fromEntries(
      Object.entries(clue.revealReasons).filter(([targetId]) => visibleClueIds.has(targetId))
    )
    : undefined;
  return {
    ...clue,
    reveals,
    revealReasons
  };
}

function compareModules(left: ModuleClueSummary, right: ModuleClueSummary): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function visiblePlayerIdsForClue(
  clue: ModuleClueRecord,
  visibility: ModuleClueVisibilityFile,
  supportedPlayerIds: string[]
): string[] {
  if (Object.prototype.hasOwnProperty.call(visibility.clues, clue.id)) {
    return visibility.clues[clue.id] ?? [];
  }
  return clue.isInitial ? supportedPlayerIds : [];
}

export async function listModuleClueSummaries(
  contentRootDir: string,
  visibilityRootDir: string,
  supportedPlayerIds: string[],
  session: { playerId: string; displayName: string; isKeeper?: boolean }
): Promise<ModuleClueSummary[]> {
  const entries = await readdir(contentRootDir, { withFileTypes: true });
  const modules: ModuleClueSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleId = assertSafeSegment(entry.name, "moduleId");
    let file: ModuleClueFile;
    try {
      file = await readModuleClueFile(contentRootDir, moduleId);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    const visibility = await readVisibilityFile(visibilityRootDir, moduleId);
    const hasVisibleClue =
      session.isKeeper ||
      file.clues.some((clue) =>
        visiblePlayerIdsForClue(clue, visibility, supportedPlayerIds).includes(session.playerId)
      );
    if (hasVisibleClue) modules.push({ id: file.moduleId, name: file.moduleName });
  }

  return modules.sort(compareModules);
}

export async function readModuleCluePayload(
  contentRootDir: string,
  visibilityRootDir: string,
  moduleId: string,
  session: { playerId: string; displayName: string; isKeeper?: boolean },
  supportedPlayerIds: string[],
  players: Array<{ id: string; name: string }>
): Promise<ModuleCluePayload> {
  const file = await readModuleClueFile(contentRootDir, moduleId);
  const visibility = await readVisibilityFile(visibilityRootDir, moduleId);
  const allClues = file.clues.slice().sort(compareClues);
  const visibleClues = session.isKeeper
    ? allClues
    : allClues.filter((clue) =>
      visiblePlayerIdsForClue(clue, visibility, supportedPlayerIds).includes(session.playerId)
    );
  if (!session.isKeeper && visibleClues.length === 0) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  }
  const visibleClueIds = new Set(visibleClues.map((clue) => clue.id));
  const safeVisibleClues = visibleClues.map((clue) => filterClueLinks(clue, visibleClueIds));
  const clues = visibleClues.map((clue) =>
    session.isKeeper
      ? {
        ...filterClueLinks(clue, visibleClueIds),
        visiblePlayerIds: visiblePlayerIdsForClue(clue, visibility, supportedPlayerIds)
      }
      : filterClueLinks(clue, visibleClueIds)
  );

  return {
    module: { id: file.moduleId, name: file.moduleName },
    clues,
    edges: buildEdges(safeVisibleClues),
    tags: deriveTags(safeVisibleClues),
    players: session.isKeeper ? players : undefined
  };
}

export function validateVisibilityUpdateBody(
  value: unknown,
  supportedPlayerIds: string[]
): VisibilityUpdateBody {
  const body = requireObject(value, "request body");
  if (typeof body.playerId === "string") throw new Error("playerId is not allowed");
  const playerIds = requireStringArray(body.playerIds, "playerIds").map((playerId) =>
    assertSafeSegment(playerId, "playerId")
  );
  const supported = new Set(supportedPlayerIds);
  for (const playerId of playerIds) {
    if (!supported.has(playerId)) throw new Error(`unsupported playerId: ${playerId}`);
  }
  return { playerIds };
}

export async function updateModuleClueVisibility(
  contentRootDir: string,
  visibilityRootDir: string,
  moduleId: string,
  clueId: string,
  playerIds: string[]
): Promise<void> {
  const file = await readModuleClueFile(contentRootDir, moduleId);
  const safeClueId = assertSafeSegment(clueId, "clueId");
  if (!file.clues.some((clue) => clue.id === safeClueId)) throw new Error("clueId not found");

  const visibility = await readVisibilityFile(visibilityRootDir, moduleId);
  visibility.clues[safeClueId] = playerIds;
  const path = visibilityFilePath(visibilityRootDir, moduleId);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(visibility, null, 2)}\n`, "utf-8");
  await rename(tmpPath, path);
}
