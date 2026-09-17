import { tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";

// ─── Constants ──────────────────────────────────────────────────────────

const PLUGIN_NAME = "telegram-rag-cache";
const DATA_DIR = path.join(os.homedir(), ".lmstudio", "plugin-data", PLUGIN_NAME);
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────

interface TelegramMessage {
  id: number;
  channel: string;
  text: string;
  timestamp: number;
  date: string;
}

interface CacheData {
  channel: string;
  messages: TelegramMessage[];
  lastUpdated: number;
  earliestId: number;
  latestId: number;
}

interface SearchResult {
  id: number;
  channel: string;
  text: string;
  date: string;
  score: number;
}

// ─── Config access ──────────────────────────────────────────────────────

function getConfigValue(ctl: ToolsProviderController, key: string, fallback: unknown): unknown {
  try {
    const anyCtl = ctl as unknown as { 
      pluginConfig?: { 
        fields?: Array<{ key: string; value: unknown }> 
      } 
    };
    
    const fields = anyCtl.pluginConfig?.fields;
    if (Array.isArray(fields)) {
      const field = fields.find((f) => f.key === key);
      if (field && field.value !== undefined) {
        return field.value;
      }
    }
  } catch {}
  return fallback;
}

function windowToMs(window: string): number {
  switch (window) {
    case "1w": return 7 * DAY_MS;
    case "1m": return 30 * DAY_MS;
    case "3m": return 90 * DAY_MS;
    case "6m": return 180 * DAY_MS;
    case "9m": return 270 * DAY_MS;
    case "12m": return 365 * DAY_MS;
    case "24m": return 730 * DAY_MS;
    default: return 30 * DAY_MS;
  }
}

// ─── JSON file wrappers ─────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function sanitizeChannel(channel: string): string {
  return channel.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getCachePath(channel: string): string {
  ensureDataDir();
  return path.join(DATA_DIR, `cache_${sanitizeChannel(channel)}.json`);
}

function readCache(channel: string): CacheData {
  const empty: CacheData = { channel, messages: [], lastUpdated: 0, earliestId: 0, latestId: 0 };
  try {
    const p = getCachePath(channel);
    if (!fs.existsSync(p)) return empty;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as CacheData;
    if (!parsed || !Array.isArray(parsed.messages)) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

function writeCache(data: CacheData): void {
  ensureDataDir();
  fs.writeFileSync(getCachePath(data.channel), JSON.stringify(data, null, 2), "utf8");
}

function getWatchlistPath(): string {
  ensureDataDir();
  return path.join(DATA_DIR, "watchlist.json");
}

function readWatchlist(): string[] {
  try {
    const p = getWatchlistPath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((c) => typeof c === "string");
    return [];
  } catch {
    return [];
  }
}

function writeWatchlist(channels: string[]): void {
  ensureDataDir();
  fs.writeFileSync(getWatchlistPath(), JSON.stringify(channels, null, 2), "utf8");
}

// ─── HTTP fetch & HTML parsing ──────────────────────────────────────────

function httpGet(url: string, headers: Record<string, string> = {}, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
        const next = res.headers.location.startsWith("http") 
          ? res.headers.location 
          : new URL(res.headers.location, url).toString();
        httpGet(next, headers, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Request timeout")));
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMessages(html: string): TelegramMessage[] {
  const messages: TelegramMessage[] = [];
  const postRegex = /data-post="([^"]+)"/g;
  const marks: { post: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = postRegex.exec(html)) !== null) {
    marks.push({ post: m[1], index: m.index + m[0].length });
  }

  for (let i = 0; i < marks.length; i++) {
    const { post, index: startIdx } = marks[i];
    const slashIdx = post.lastIndexOf("/");
    if (slashIdx < 0) continue;
    const msgChannel = post.slice(0, slashIdx);
    const msgId = parseInt(post.slice(slashIdx + 1), 10);
    if (isNaN(msgId)) continue;

    const endIdx = i + 1 < marks.length ? marks[i + 1].index : html.length;
    const slice = html.slice(startIdx, endIdx);

    let text = "";
    const textMatch = slice.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (textMatch) text = stripHtml(textMatch[1]);

    let timestamp = Date.now();
    let date = new Date().toISOString();
    const timeMatch = slice.match(/<time datetime="([^"]+)"/);
    if (timeMatch) {
      const parsed = Date.parse(timeMatch[1]);
      if (!isNaN(parsed)) {
        timestamp = parsed;
        date = timeMatch[1];
      }
    }

    if (text.length > 0) {
      messages.push({ id: msgId, channel: msgChannel, text, timestamp, date });
    }
  }
  return messages;
}

async function fetchPage(channel: string, beforeId?: number): Promise<{ messages: TelegramMessage[]; minId: number; maxId: number }> {
  let url = `https://t.me/s/${encodeURIComponent(channel)}`;
  if (beforeId) url += `?before=${beforeId}`;
  const html = await httpGet(url, {
    "User-Agent": "Mozilla/5.0 (compatible; LMStudioTelegramRAG/1.0)",
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  const messages = parseMessages(html);
  let minId = Number.MAX_SAFE_INTEGER;
  let maxId = 0;
  for (const msg of messages) {
    if (msg.id < minId) minId = msg.id;
    if (msg.id > maxId) maxId = msg.id;
  }
  if (minId === Number.MAX_SAFE_INTEGER) minId = 0;
  return { messages, minId, maxId };
}

// ─── RAG: tokenisation + cosine similarity ──────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff]+/g) || [];
}

function buildTf(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    if (t.length < 2) continue;
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, magA = 0, magB = 0;
  for (const [k, v] of a) {
    magA += v * v;
    const bv = b.get(k);
    if (bv) dot += v * bv;
  }
  for (const [, v] of b) magB += v * v;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function searchInCache(cache: CacheData, query: string, limit: number, windowMs: number): SearchResult[] {
  const cutoff = Date.now() - windowMs;
  const queryTokens = tokenize(query);
  const queryTf = buildTf(queryTokens);
  const queryTerms = queryTokens.filter((t) => t.length >= 3);
  const results: SearchResult[] = [];

  for (const msg of cache.messages) {
    if (msg.timestamp < cutoff) continue;
    const msgTf = buildTf(tokenize(msg.text));
    let score = cosineSim(queryTf, msgTf);

    const lowerText = msg.text.toLowerCase();
    for (const qt of queryTerms) {
      if (lowerText.includes(qt)) score += 0.15;
    }

    if (score > 0.001) {
      results.push({ id: msg.id, channel: msg.channel, text: msg.text, date: msg.date, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ─── Reusable fetch logic ───────────────────────────────────────────────

async function fetchAndCacheChannel(ctl: ToolsProviderController, channel: string, maxPages?: number): Promise<Record<string, unknown>> {
  const pages = maxPages ?? (getConfigValue(ctl, "defaultFetchPages", 5) as number);
  const maxCached = getConfigValue(ctl, "maxCachedMessages", 5000) as number;
  const historyWindow = getConfigValue(ctl, "historyWindow", "1m") as string;
  const windowMs = windowToMs(historyWindow);
  const cutoff = Date.now() - windowMs;

  const cache = readCache(channel);
  const existingIds = new Set(cache.messages.map((m) => m.id));
  const newMessages: TelegramMessage[] = [];
  let beforeId: number | undefined = undefined;
  let pagesFetched = 0;
  let stop = false;
  let lastError: string | null = null;

  while (pagesFetched < pages && !stop) {
    try {
      const page = await fetchPage(channel, beforeId);
      if (page.messages.length === 0) { stop = true; break; }
      let oldestTs = Number.MAX_SAFE_INTEGER;
      for (const msg of page.messages) {
        if (!existingIds.has(msg.id)) {
          newMessages.push(msg);
          existingIds.add(msg.id);
        }
        if (msg.timestamp < oldestTs) oldestTs = msg.timestamp;
      }
      if (oldestTs < cutoff) stop = true;
      if (page.minId === 0) { stop = true; } else { beforeId = page.minId; }
      pagesFetched++;
      if (pagesFetched < pages && !stop) await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      stop = true;
    }
  }

  const all = [...cache.messages, ...newMessages];
  const seen = new Set<number>();
  const deduped = all.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  deduped.sort((a, b) => a.id - b.id);
  if (deduped.length > maxCached) deduped.splice(0, deduped.length - maxCached);

  const newCache: CacheData = {
    channel, messages: deduped, lastUpdated: Date.now(),
    earliestId: deduped.length > 0 ? deduped[0].id : 0,
    latestId: deduped.length > 0 ? deduped[deduped.length - 1].id : 0,
  };
  writeCache(newCache);

  const inWindow = deduped.filter((m) => m.timestamp >= cutoff).length;
  return {
    channel, pagesFetched, newMessagesAdded: newMessages.length,
    totalCached: deduped.length, inWindow, historyWindow,
    earliest: deduped.length > 0 ? deduped[0].date : null,
    latest: deduped.length > 0 ? deduped[deduped.length - 1].date : null,
    ...(lastError ? { warning: `Stopped early: ${lastError}` } : {}),
  };
}

// ─── Tools provider ─────────────────────────────────────────────────────

export async function toolsProvider(ctl: ToolsProviderController) {
  return [
    tool({
      name: "telegram_fetch_channel",
      description: "Fetch recent messages from a public Telegram channel and merge them into the local RAG cache.",
      parameters: {
        channel: z.string().min(1).describe("Telegram public channel name (without @, without t.me/ prefix)"),
        maxPages: z.number().int().min(1).max(50).optional().describe("Max pages to fetch."),
      },
      implementation: async ({ channel, maxPages }) => {
        return await fetchAndCacheChannel(ctl, channel, maxPages);
      },
    }),

    tool({
      name: "telegram_search",
      description: "Search the local RAG cache of a Telegram channel's messages using cosine similarity.",
      parameters: {
        channel: z.string().min(1).describe("Telegram public channel name"),
        query: z.string().min(1).describe("Natural-language search query"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results."),
      },
      implementation: async ({ channel, query, limit }) => {
        const lim = limit ?? (getConfigValue(ctl, "searchResultLimit", 10) as number);
        const historyWindow = getConfigValue(ctl, "historyWindow", "1m") as string;
        const windowMs = windowToMs(historyWindow);
        const cache = readCache(channel);
        if (cache.messages.length === 0) return { channel, query, results: [], message: "Cache is empty." };
        const results = searchInCache(cache, query, lim, windowMs);
        return {
          channel, query, historyWindow, totalCached: cache.messages.length, resultCount: results.length,
          results: results.map((r) => ({
            id: r.id, date: r.date, score: Number(r.score.toFixed(4)),
            text: r.text.length > 1200 ? r.text.slice(0, 1200) + "…" : r.text,
            url: `https://t.me/${channel}/${r.id}`,
          })),
        };
      },
    }),

    tool({
      name: "telegram_watchlist_add",
      description: "Add a Telegram channel to the watchlist.json file for regular syncing.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel name") },
      implementation: async ({ channel }) => {
        const list = readWatchlist();
        const lower = channel.toLowerCase();
        if (!list.includes(lower)) {
          list.push(lower);
          writeWatchlist(list);
          return { channel, added: true, totalChannels: list.length };
        }
        return { channel, added: false, message: "Already in watchlist.", totalChannels: list.length };
      },
    }),

    tool({
      name: "telegram_watchlist_remove",
      description: "Remove a Telegram channel from the watchlist.json file.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel name") },
      implementation: async ({ channel }) => {
        const list = readWatchlist();
        const lower = channel.toLowerCase();
        const newList = list.filter((c) => c !== lower);
        if (newList.length === list.length) return { channel, removed: false, message: "Not found in watchlist." };
        writeWatchlist(newList);
        return { channel, removed: true, totalChannels: newList.length };
      },
    }),

    tool({
      name: "telegram_watchlist_sync",
      description: "Fetch and update the RAG cache for ALL channels listed in watchlist.json.",
      parameters: {},
      implementation: async () => {
        const list = readWatchlist();
        if (list.length === 0) return { message: "Watchlist is empty." };
        const results: Record<string, unknown>[] = [];
        for (const channel of list) {
          const res = await fetchAndCacheChannel(ctl, channel);
          results.push(res);
          await new Promise((r) => setTimeout(r, 500));
        }
        return { totalChannels: list.length, results };
      },
    }),

    tool({
      name: "telegram_cache_stats",
      description: "Return statistics about the local message cache for a Telegram channel.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel name") },
      implementation: async ({ channel }) => {
        const cache = readCache(channel);
        const historyWindow = getConfigValue(ctl, "historyWindow", "1m") as string;
        const windowMs = windowToMs(historyWindow);
        const cutoff = Date.now() - windowMs;
        const inWindow = cache.messages.filter((m) => m.timestamp >= cutoff).length;
        return {
          channel, historyWindow, totalCached: cache.messages.length, inWindow,
          earliest: cache.messages.length > 0 ? cache.messages[0].date : null,
          latest: cache.messages.length > 0 ? cache.messages[cache.messages.length - 1].date : null,
          lastUpdated: cache.lastUpdated ? new Date(cache.lastUpdated).toISOString() : null,
        };
      },
    }),

    tool({
      name: "telegram_get_recent",
      description: "Return the most recent N cached messages for a Telegram channel, newest first.",
      parameters: {
        channel: z.string().min(1).describe("Telegram public channel name"),
        count: z.number().int().min(1).max(50).optional().describe("Number of messages. Default 10."),
      },
      implementation: async ({ channel, count }) => {
        const n = count ?? 10;
        const cache = readCache(channel);
        if (cache.messages.length === 0) return { channel, messages: [], message: "Cache is empty." };
        const recent = cache.messages.slice(-n).reverse();
        return {
          channel, count: recent.length,
          messages: recent.map((m) => ({
            id: m.id, date: m.date,
            text: m.text.length > 1200 ? m.text.slice(0, 1200) + "…" : m.text,
            url: `https://t.me/${channel}/${m.id}`,
          })),
        };
      },
    }),

    tool({
      name: "telegram_list_channels",
      description: "List all Telegram channels that have cached messages on disk.",
      parameters: {},
      implementation: async () => {
        ensureDataDir();
        const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("cache_") && f.endsWith(".json"));
        const channels: Array<{ channel: string; messageCount: number; lastUpdated: string | null }> = [];
        for (const f of files) {
          try {
            const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
            const data = JSON.parse(raw) as CacheData;
            channels.push({
              channel: data.channel, messageCount: data.messages?.length || 0,
              lastUpdated: data.lastUpdated ? new Date(data.lastUpdated).toISOString() : null,
            });
          } catch {}
        }
        return { channels };
      },
    }),

       tool({
      name: "telegram_clear_cache",
      description: "Delete the local cache file for a Telegram channel.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel name") },
      implementation: async ({ channel }) => {
        const p = getCachePath(channel);
        if (fs.existsSync(p)) { fs.unlinkSync(p); return { channel, cleared: true }; }
        return { channel, cleared: false, message: "No cache file found." };
      },
    }),

      
  ];
}