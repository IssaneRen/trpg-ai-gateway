import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthSession } from "../auth/tokens.js";

export interface AnalyticsEventInput {
  eventName: string;
  eventTime?: string;
  anonymousId?: string;
  sessionId?: string;
  pagePath?: string;
  pageUrl?: string;
  pageTitle?: string;
  referrer?: string;
  properties?: Record<string, unknown>;
}

export interface StoredAnalyticsEvent extends Required<Pick<AnalyticsEventInput, "eventName">> {
  eventId: string;
  eventTime: string;
  receivedAt: string;
  anonymousId?: string;
  sessionId?: string;
  pagePath?: string;
  pageUrl?: string;
  pageTitle?: string;
  referrer?: string;
  properties?: Record<string, unknown>;
  playerId?: string;
  playerDisplayName?: string;
  isKeeper?: boolean;
  ip?: string;
  userAgent?: string;
}

interface AppendAnalyticsEventOptions {
  session?: AuthSession;
  now: Date;
  ip?: string;
  userAgent?: string;
  maxEvents?: number;
}

export interface AnalyticsSummary {
  totals: {
    events: number;
    pageViews: number;
    clicks: number;
    uniqueVisitors: number;
  };
  topPages: Array<{ pagePath: string; pv: number; uv: number }>;
  topClicks: Array<{ eventName: string; pv: number; uv: number }>;
  players: Array<{ playerId: string; displayName: string; events: number }>;
  recentEvents: Array<{
    eventName: string;
    eventTime: string;
    pagePath?: string;
    playerDisplayName?: string;
  }>;
}

const EVENTS_FILE = "events.jsonl";

function analyticsEventsPath(rootDir: string): string {
  return join(rootDir, EVENTS_FILE);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalProperties(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("properties must be an object");
  }
  return value as Record<string, unknown>;
}

function normalizeIsoTime(value: unknown, fallback: Date): string {
  const raw = optionalString(value);
  if (!raw) return fallback.toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error("eventTime must be an ISO date string");
  return parsed.toISOString();
}

function visitorKey(event: StoredAnalyticsEvent): string {
  return event.playerId || event.anonymousId || event.sessionId || event.eventId;
}

function isPageView(event: StoredAnalyticsEvent): boolean {
  return event.eventName === "page_view";
}

function isClick(event: StoredAnalyticsEvent): boolean {
  return event.eventName === "click" || event.eventName.startsWith("click_");
}

function topByPvUv(
  events: StoredAnalyticsEvent[],
  keyOf: (event: StoredAnalyticsEvent) => string | undefined
): Array<{ key: string; pv: number; uv: number }> {
  const buckets = new Map<string, { pv: number; visitors: Set<string> }>();
  for (const event of events) {
    const key = keyOf(event);
    if (!key) continue;
    const bucket = buckets.get(key) ?? { pv: 0, visitors: new Set<string>() };
    bucket.pv += 1;
    bucket.visitors.add(visitorKey(event));
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({ key, pv: bucket.pv, uv: bucket.visitors.size }))
    .sort((a, b) => b.pv - a.pv)
    .slice(0, 20);
}

export function validateAnalyticsEventBody(value: unknown, now: Date): AnalyticsEventInput {
  if (!value || typeof value !== "object") throw new Error("request body must be JSON");
  const candidate = value as Record<string, unknown>;
  return {
    eventName: requireString(candidate.eventName, "eventName"),
    eventTime: normalizeIsoTime(candidate.eventTime, now),
    anonymousId: optionalString(candidate.anonymousId),
    sessionId: optionalString(candidate.sessionId),
    pagePath: optionalString(candidate.pagePath),
    pageUrl: optionalString(candidate.pageUrl),
    pageTitle: optionalString(candidate.pageTitle),
    referrer: optionalString(candidate.referrer),
    properties: optionalProperties(candidate.properties)
  };
}

export async function appendAnalyticsEvent(
  rootDir: string,
  input: AnalyticsEventInput,
  options: AppendAnalyticsEventOptions
): Promise<StoredAnalyticsEvent> {
  await mkdir(rootDir, { recursive: true });
  const eventTime = input.eventTime ?? options.now.toISOString();
  const event: StoredAnalyticsEvent = {
    eventId: `evt_${randomUUID()}`,
    eventName: input.eventName,
    eventTime,
    receivedAt: eventTime,
    anonymousId: input.anonymousId,
    sessionId: input.sessionId,
    pagePath: input.pagePath,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    referrer: input.referrer,
    properties: input.properties,
    playerId: options.session?.playerId,
    playerDisplayName: options.session?.displayName,
    isKeeper: options.session?.isKeeper,
    ip: options.ip,
    userAgent: options.userAgent
  };
  const filePath = analyticsEventsPath(rootDir);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  if (options.maxEvents) await trimAnalyticsEvents(filePath, options.maxEvents);
  return event;
}

async function trimAnalyticsEvents(filePath: string, maxEvents: number): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= maxEvents) return;
  await writeFile(filePath, `${lines.slice(-maxEvents).join("\n")}\n`, "utf-8");
}

async function readAnalyticsEvents(rootDir: string): Promise<StoredAnalyticsEvent[]> {
  try {
    const raw = await readFile(analyticsEventsPath(rootDir), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredAnalyticsEvent);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readAnalyticsSummary(rootDir: string): Promise<AnalyticsSummary> {
  const events = await readAnalyticsEvents(rootDir);
  const pageViews = events.filter(isPageView);
  const clicks = events.filter(isClick);
  const visitors = new Set(events.map(visitorKey));
  const players = new Map<string, { playerId: string; displayName: string; events: number }>();

  for (const event of events) {
    if (!event.playerId || !event.playerDisplayName) continue;
    const player = players.get(event.playerId) ?? {
      playerId: event.playerId,
      displayName: event.playerDisplayName,
      events: 0
    };
    player.events += 1;
    players.set(event.playerId, player);
  }

  return {
    totals: {
      events: events.length,
      pageViews: pageViews.length,
      clicks: clicks.length,
      uniqueVisitors: visitors.size
    },
    topPages: topByPvUv(pageViews, (event) => event.pagePath).map((item) => ({
      pagePath: item.key,
      pv: item.pv,
      uv: item.uv
    })),
    topClicks: topByPvUv(clicks, (event) => event.eventName).map((item) => ({
      eventName: item.key,
      pv: item.pv,
      uv: item.uv
    })),
    players: [...players.values()].sort((a, b) => b.events - a.events).slice(0, 20),
    recentEvents: events
      .slice(-20)
      .reverse()
      .map((event) => ({
        eventName: event.eventName,
        eventTime: event.eventTime,
        pagePath: event.pagePath,
        playerDisplayName: event.playerDisplayName
      }))
  };
}
