import { tool, type ToolsProviderController, type InferParsedConfig } from "@lmstudio/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { pluginConfigSchematics } from "./config.js";

// --- Constants ---------------------------------------------------------------

const PLUGIN_NAME = "telegram-rag-cache";
const DATA_DIR = path.join(os.homedir(), ".lmstudio", "plugin-data", PLUGIN_NAME);
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 1;

function logDiagnostic(level: "info" | "warn", event: string, fields: Record<string, string | number | boolean>): void {
  console[level](`[telegram-rag-cache] ${JSON.stringify({ event, ...fields })}`);
}

function errorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/time limit|timeout/i.test(message)) return "timeout";
  if (/limit exceeded/i.test(message)) return "limit_exceeded";
  if (/invalid cache|invalid message|duplicate|cache changed/i.test(message)) return "invalid_cache";
  if (/HTTP 429/i.test(message)) return "http_429";
  if (/HTTP 5\d\d/i.test(message)) return "http_5xx";
  if (/HTTP \d+/i.test(message)) return "http_error";
  if (/EACCES|EPERM/i.test(message)) return "permission_denied";
  if (/ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) return "network_error";
  return "other";
}

// --- Types -------------------------------------------------------------------

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
  schemaVersion?: number;
}

interface SearchResult {
  id: number;
  channel: string;
  text: string;
  date: string;
  score: number;
}

// --- Config access -----------------------------------------------------------

interface PluginConfigValues {
  historyWindow: string;
  maxCachedMessages: number;
  defaultFetchPages: number;
  searchResultLimit: number;
}

const DEFAULT_CONFIG: PluginConfigValues = {
  historyWindow: "1m",
  maxCachedMessages: 5000,
  defaultFetchPages: 5,
  searchResultLimit: 10,
};

function getConfig(ctl: ToolsProviderController): PluginConfigValues {
  try {
    const cfg: InferParsedConfig<typeof pluginConfigSchematics> = ctl.getPluginConfig(pluginConfigSchematics);
    return {
      historyWindow: cfg.get("historyWindow"),
      maxCachedMessages: cfg.get("maxCachedMessages"),
      defaultFetchPages: cfg.get("defaultFetchPages"),
      searchResultLimit: cfg.get("searchResultLimit"),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
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

// --- Input normalization -----------------------------------------------------

function normalizeChannelInput(raw: string): string {
  if (!raw || typeof raw !== "string") {
    throw new Error("Channel name must be a non-empty string");
  }
  let s = raw.trim();
  s = s.replace(/^@/, "");
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i, "");
  s = s.replace(/^s\//i, "");
  const qIndex = s.indexOf("?");
  if (qIndex >= 0) s = s.slice(0, qIndex);
  const hashIndex = s.indexOf("#");
  if (hashIndex >= 0) s = s.slice(0, hashIndex);
  s = s.replace(/^\/+|\/+$/g, "");
  if (s.includes("/")) {
    s = s.split("/")[0];
  }
  s = s.toLowerCase();
  if (!/^[a-z0-9_]{3,64}$/.test(s)) {
    throw new Error(`Invalid channel name "${raw}" after normalization. Use a valid public channel handle (3-64 alphanumeric/underscore chars).`);
  }
  return s;
}

// --- Atomic storage & IO -----------------------------------------------------

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function atomicWriteFileSync(filePath: string, data: string): void {
  ensureDataDir();
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, data, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function sanitizeChannel(channel: string): string {
  return channel.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getCachePath(channel: string): string {
  ensureDataDir();
  const normalized = normalizeChannelInput(channel);
  return path.join(DATA_DIR, `cache_${sanitizeChannel(normalized)}.json`);
}

function readCache(channel: string): CacheData {
  const normalized = normalizeChannelInput(channel);
  const empty: CacheData = {
    channel: normalized,
    messages: [],
    lastUpdated: 0,
    earliestId: 0,
    latestId: 0,
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
  try {
    const p = getCachePath(normalized);
    if (!fs.existsSync(p)) return empty;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as CacheData;
    if (!parsed || !Array.isArray(parsed.messages)) return empty;
    return {
      channel: normalized,
      messages: parsed.messages.map((m) => ({ ...m, channel: normalized })),
      lastUpdated: parsed.lastUpdated || 0,
      earliestId: parsed.earliestId || (parsed.messages.length > 0 ? parsed.messages[0].id : 0),
      latestId: parsed.latestId || (parsed.messages.length > 0 ? parsed.messages[parsed.messages.length - 1].id : 0),
      schemaVersion: parsed.schemaVersion || CACHE_SCHEMA_VERSION,
    };
  } catch {
    return empty;
  }
}

function writeCache(data: CacheData): void {
  const normalized = normalizeChannelInput(data.channel);
  const toWrite: CacheData = {
    ...data,
    channel: normalized,
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
  const p = getCachePath(normalized);
  atomicWriteFileSync(p, JSON.stringify(toWrite, null, 2));
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
    if (Array.isArray(parsed)) {
      return parsed
        .filter((c): c is string => typeof c === "string")
        .map((c) => {
          try {
            return normalizeChannelInput(c);
          } catch {
            return "";
          }
        })
        .filter((c) => c.length >= 3);
    }
    return [];
  } catch {
    return [];
  }
}

function writeWatchlist(channels: string[]): void {
  const normalized = channels
    .map((c) => {
      try {
        return normalizeChannelInput(c);
      } catch {
        return "";
      }
    })
    .filter((c) => c.length >= 3);
  const unique = Array.from(new Set(normalized));
  atomicWriteFileSync(getWatchlistPath(), JSON.stringify(unique, null, 2));
}

// --- HTTP fetch & HTML parsing -----------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return ms + Math.random() * ms * 0.3;
}

function httpGetOnce(
  url: string,
  headers: Record<string, string>,
  redirectsLeft: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        httpGetOnce(next, headers, redirectsLeft - 1).then(resolve).catch(reject);
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

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
  maxRedirects = 5,
  maxAttempts = 3,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await httpGetOnce(url, headers, maxRedirects);
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retriable =
        msg === "Request timeout" ||
        /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg) ||
        /HTTP 429/.test(msg) ||
        /HTTP 5\d\d/.test(msg);
      if (attempt < maxAttempts && retriable) {
        await sleep(jitter(500 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return !isNaN(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return !isNaN(code) ? String.fromCodePoint(code) : _;
    });
}

function stripHtml(html: string): string {
  const withoutTags = html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withoutTags)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBalancedDivs(htmlSlice: string, openDivRegex: RegExp): string[] {
  const extracted: string[] = [];
  const flags = openDivRegex.flags.includes("g") ? openDivRegex.flags : openDivRegex.flags + "g";
  const matcher = new RegExp(openDivRegex.source, flags);
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(htmlSlice)) !== null) {
    const contentStart = match.index + match[0].length;
    const tagScanner = /<\/?div\b[^>]*>/gi;
    tagScanner.lastIndex = contentStart;
    let depth = 1;
    let tagMatch: RegExpExecArray | null;

    while (depth > 0 && (tagMatch = tagScanner.exec(htmlSlice)) !== null) {
      if (tagMatch[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          extracted.push(htmlSlice.slice(contentStart, tagMatch.index));
          matcher.lastIndex = tagScanner.lastIndex;
          break;
        }
      } else if (!tagMatch[0].endsWith("/>")) {
        depth++;
      }
    }
  }
  return extracted;
}

function extractFallbackText(slice: string): string {
  const pollQuestion = extractBalancedDivs(slice, /<div\s+class="[^"]*\btgme_widget_message_poll_question\b[^"]*"[^>]*>/i);
  if (pollQuestion.length > 0) {
    return `[Poll] ${stripHtml(pollQuestion[0])}`;
  }
  const forwarded = slice.match(/data-peer-title="([^"]+)"/);
  if (forwarded) return `[Forwarded: ${decodeHtmlEntities(forwarded[1])}]`;
  const mediaTypes = [
    { re: /tgme_widget_message_photo|data-photo="[^"]+"/, tag: "[Photo]" },
    { re: /tgme_widget_message_video|data-video="[^"]+"/, tag: "[Video]" },
    { re: /tgme_widget_message_poll/, tag: "[Poll]" },
    { re: /tgme_widget_message_document/, tag: "[Document]" },
    { re: /tgme_widget_message_audio/, tag: "[Audio]" },
    { re: /tgme_widget_message_voice/, tag: "[Voice]" },
  ];
  for (const mt of mediaTypes) {
    if (mt.re.test(slice)) return mt.tag;
  }
  return "";
}

interface ParsedMessagesResult {
  messages: TelegramMessage[];
  anomalyDetected: boolean;
}

function parseMessages(html: string, expectedChannel: string): ParsedMessagesResult {
  const messages: TelegramMessage[] = [];
  const postRegex = /data-post="([^"]+)\/(\d+)"/g;
  const marks: Array<{ id: number; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = postRegex.exec(html)) !== null) {
    const msgId = parseInt(m[2], 10);
    if (!isNaN(msgId)) {
      marks.push({ id: msgId, index: m.index + m[0].length });
    }
  }

  for (let i = 0; i < marks.length; i++) {
    const { id: msgId, index: startIdx } = marks[i];
    const endIdx = i + 1 < marks.length ? marks[i + 1].index : html.length;
    const rawSlice = html.slice(startIdx, endIdx);

    // Strip replied-to preview blocks so reply text isn't mistaken for the main post body
    const sliceWithoutReply = rawSlice.replace(/<a\s+class="[^"]*\btgme_widget_message_reply\b[^"]*"[\s\S]*?<\/a>/gi, "");

    let textParts = extractBalancedDivs(
      sliceWithoutReply,
      /<div\s+class="[^"]*\btgme_widget_message_text\b[^"]*\bjs-message_text\b[^"]*"[^>]*>/i,
    );
    if (textParts.length === 0) {
      textParts = extractBalancedDivs(
        sliceWithoutReply,
        /<div\s+class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>/i,
      );
    }

    let text = textParts.map(stripHtml).filter(Boolean).join("\n\n");
    if (!text) {
      text = extractFallbackText(rawSlice);
    }

    let timestamp = Date.now();
    let date = new Date().toISOString();
    const timeMatch = rawSlice.match(/<time[^>]*datetime="([^"]+)"/i);
    if (timeMatch) {
      const parsed = Date.parse(timeMatch[1]);
      if (!isNaN(parsed)) {
        timestamp = parsed;
        date = timeMatch[1];
      }
    }

    if (text.length > 0) {
      messages.push({ id: msgId, channel: expectedChannel, text, timestamp, date });
    }
  }

  const hasPageIndicators = /tgme_page|tgme_channel_info/i.test(html);
  const anomalyDetected = hasPageIndicators && html.length > 5000 && marks.length === 0;
  return { messages, anomalyDetected };
}

async function fetchPage(
  channel: string,
  beforeId?: number,
): Promise<{ messages: TelegramMessage[]; minId: number; maxId: number; anomalyDetected: boolean }> {
  const normalized = normalizeChannelInput(channel);
  let url = `https://t.me/s/${encodeURIComponent(normalized)}`;
  if (beforeId) url += `?before=${beforeId}`;
  const html = await httpGet(url, {
    "User-Agent": "Mozilla/5.0 (compatible; LMStudioTelegramRAG/1.0)",
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9",
  });
  const parsed = parseMessages(html, normalized);
  const messages = parsed.messages;
  let minId = Number.MAX_SAFE_INTEGER;
  let maxId = 0;
  for (const msg of messages) {
    if (msg.id < minId) minId = msg.id;
    if (msg.id > maxId) maxId = msg.id;
  }
  if (minId === Number.MAX_SAFE_INTEGER) minId = 0;
  return { messages, minId, maxId, anomalyDetected: parsed.anomalyDetected };
}

// --- Tokenization & BM25 search ----------------------------------------------

function tokenizeLatinCyrillic(text: string): string[] {
  const tokens: string[] = [];
  const regex = /[a-z0-9\u00c0-\u024f\u0400-\u04ff]+/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const t = m[0].toLowerCase();
    // Drop single-character non-numeric tokens; preserve single digits (e.g. "3" in "qwen 3") and 2+ char tokens
    if (t.length === 1 && !/^\d$/.test(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

function tokenizeCjk(text: string): string[] {
  const tokens: string[] = [];
  const chars = Array.from(text);
  if (chars.length === 0) return tokens;
  for (let i = 0; i < chars.length; i++) {
    tokens.push(chars[i]);
  }
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const cjkRegex = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = cjkRegex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push(...tokenizeLatinCyrillic(text.slice(lastIndex, m.index)));
    }
    tokens.push(...tokenizeCjk(m[0]));
    lastIndex = cjkRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push(...tokenizeLatinCyrillic(text.slice(lastIndex)));
  }
  return tokens;
}

function buildTf(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    if (!t) continue;
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

function computeIdf(dfs: Map<string, number>, docCount: number): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [term, df] of dfs) {
    const idfVal = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    idf.set(term, idfVal);
  }
  return idf;
}

function bm25Score(
  docTf: Map<string, number>,
  queryTf: Map<string, number>,
  idf: Map<string, number>,
  docLen: number,
  avgDocLen: number,
  k1 = 1.5,
  b = 0.75,
): number {
  let score = 0;
  for (const [term] of queryTf) {
    const tf = docTf.get(term);
    if (!tf) continue;
    const idfVal = idf.get(term) || 0;
    if (idfVal <= 0) continue;
    const denom = tf + k1 * (1 - b + b * (docLen / (avgDocLen || 1)));
    score += (idfVal * tf * (k1 + 1)) / denom;
  }
  return score;
}

function searchDocs(
  docs: Array<{ msg: TelegramMessage; tf: Map<string, number>; tokens: string[] }>,
  query: string,
  limit: number,
  deadline?: number,
): SearchResult[] {
  if (docs.length === 0) return [];
  const queryTokens = tokenize(query);
  const queryTf = buildTf(queryTokens);
  const uniqueQuerySubstrings = Array.from(new Set(queryTokens.filter((t) => t.length >= 3)));
  const rawLowerQuery = query.trim().toLowerCase();

  const docCount = docs.length;
  let totalLen = 0;
  for (const d of docs) totalLen += d.tokens.length;
  const avgDocLen = totalLen / docCount || 1;

  const dfs = new Map<string, number>();
  for (const d of docs) {
    if (deadline && Date.now() > deadline) throw new Error("Research search time limit exceeded");
    for (const [term] of d.tf) {
      dfs.set(term, (dfs.get(term) || 0) + 1);
    }
  }
  const idf = computeIdf(dfs, docCount);

  const results: SearchResult[] = [];
  for (const d of docs) {
    if (deadline && Date.now() > deadline) throw new Error("Research search time limit exceeded");
    let score = bm25Score(d.tf, queryTf, idf, d.tokens.length, avgDocLen);
    const lowerText = d.msg.text.toLowerCase();

    if (score > 0 || (rawLowerQuery.length >= 3 && lowerText.includes(rawLowerQuery))) {
      let bonus = 0;
      if (rawLowerQuery.length >= 3 && lowerText.includes(rawLowerQuery)) {
        bonus += 0.15;
      }
      for (const qt of uniqueQuerySubstrings) {
        if (lowerText.includes(qt)) bonus += 0.1;
      }
      score += Math.min(bonus, 0.25);
    }

    if (score > 0.001) {
      results.push({
        id: d.msg.id,
        channel: d.msg.channel,
        text: d.msg.text,
        date: d.msg.date,
        score,
      });
    }
  }
  results.sort((a, b) => b.score - a.score || b.id - a.id);
  return results.slice(0, limit);
}

function searchInCache(cache: CacheData, query: string, limit: number, windowMs: number): SearchResult[] {
  const cutoff = Date.now() - windowMs;
  const docs: Array<{ msg: TelegramMessage; tf: Map<string, number>; tokens: string[] }> = [];
  for (const msg of cache.messages) {
    if (msg.timestamp < cutoff) continue;
    const tokens = tokenize(msg.text);
    docs.push({ msg, tf: buildTf(tokens), tokens });
  }
  return searchDocs(docs, query, limit);
}

function searchInCacheAll(caches: CacheData[], query: string, limit: number, windowMs: number): SearchResult[] {
  const cutoff = Date.now() - windowMs;
  const docs: Array<{ msg: TelegramMessage; tf: Map<string, number>; tokens: string[] }> = [];
  for (const cache of caches) {
    for (const msg of cache.messages) {
      if (msg.timestamp < cutoff) continue;
      const tokens = tokenize(msg.text);
      docs.push({ msg, tf: buildTf(tokens), tokens });
    }
  }
  return searchDocs(docs, query, limit);
}

// --- Reusable fetch logic ----------------------------------------------------

async function fetchAndCacheChannel(
  ctl: ToolsProviderController,
  channel: string,
  maxPages?: number,
  forceFullPages?: boolean,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const config = getConfig(ctl);
  const pages = maxPages ?? config.defaultFetchPages;
  const maxCached = config.maxCachedMessages;
  const historyWindow = config.historyWindow;
  const windowMs = windowToMs(historyWindow);
  const cutoff = Date.now() - windowMs;
  const normalized = normalizeChannelInput(channel);

  const cache = readCache(normalized);
  const existingIds = new Set(cache.messages.map((m) => m.id));
  const newMessages: TelegramMessage[] = [];
  let beforeId: number | undefined = undefined;
  let pagesFetched = 0;
  let stop = false;
  let lastError: string | null = null;
  let parseAnomaly = false;

  while (pagesFetched < pages && !stop) {
    try {
      const page = await fetchPage(normalized, beforeId);
      if (page.anomalyDetected && pagesFetched === 0) {
        parseAnomaly = true;
      }
      if (page.messages.length === 0) {
        stop = true;
        break;
      }
      let oldestTs = Number.MAX_SAFE_INTEGER;
      let hasOldOrDupe = false;
      for (const msg of page.messages) {
        if (!existingIds.has(msg.id)) {
          newMessages.push(msg);
          existingIds.add(msg.id);
        }
        if (msg.timestamp < oldestTs) oldestTs = msg.timestamp;
        if (cache.latestId > 0 && !forceFullPages && msg.id <= cache.latestId) {
          hasOldOrDupe = true;
        }
      }
      if (oldestTs < cutoff) stop = true;
      if (!forceFullPages && cache.latestId > 0 && hasOldOrDupe) {
        stop = true;
      }
      if (page.minId === 0) {
        stop = true;
      } else {
        beforeId = page.minId;
      }
      pagesFetched++;
      if (pagesFetched < pages && !stop) await sleep(300);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      stop = true;
    }
  }

  const all = [...cache.messages, ...newMessages];
  const seen = new Set<number>();
  const deduped = all.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  deduped.sort((a, b) => a.id - b.id);
  if (deduped.length > maxCached) deduped.splice(0, deduped.length - maxCached);

  const newCache: CacheData = {
    channel: normalized,
    messages: deduped,
    lastUpdated: Date.now(),
    earliestId: deduped.length > 0 ? deduped[0].id : 0,
    latestId: deduped.length > 0 ? deduped[deduped.length - 1].id : 0,
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
  writeCache(newCache);

  const syncFields: Record<string, string | number | boolean> = {
    durationMs: Date.now() - startedAt, pagesFetched, newMessages: newMessages.length,
    cachedMessages: deduped.length, parseAnomaly, status: lastError ? "failed_or_partial" : parseAnomaly ? "parse_anomaly" : "completed",
  };
  if (lastError) syncFields.errorCategory = errorCategory(lastError);
  logDiagnostic(lastError || parseAnomaly ? "warn" : "info", "sync_finished", syncFields);

  const inWindow = deduped.filter((m) => m.timestamp >= cutoff).length;
  return {
    channel: normalized,
    pagesFetched,
    newMessagesAdded: newMessages.length,
    totalCached: deduped.length,
    inWindow,
    historyWindow,
    earliest: deduped.length > 0 ? deduped[0].date : null,
    latest: deduped.length > 0 ? deduped[deduped.length - 1].date : null,
    ...(lastError ? { warning: `Stopped early: ${lastError}` } : {}),
    ...(parseAnomaly ? { parseAnomaly: true, warning: "Channel HTML loaded (>5KB) but zero messages matched parser selectors." } : {}),
  };
}

function formatText(text: string, fullText: boolean): string {
  if (fullText) return text;
  if (text.length > 1200) return text.slice(0, 1200) + "\u2026";
  return text;
}

// The research contract is read-only. It deliberately reads the existing JSON
// files rather than silently migrating or changing the behavior of other tools.
const RESEARCH_CONTRACT_VERSION = "1.0";
const RESEARCH_PLUGIN_ID = "mh825/telegram-rag-cache";
const RESEARCH_TIMEOUT_MS = 2000;
const RESEARCH_MAX_BYTES = 32 * 1024 * 1024;
const RESEARCH_MAX_MESSAGES = 20000;

async function withResearchDeadline<T>(operation: string, work: (deadline: number) => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const deadline = Date.now() + RESEARCH_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work(deadline),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Research operation time limit exceeded")), RESEARCH_TIMEOUT_MS);
      }),
    ]);
    logDiagnostic("info", "research_finished", { operation, status: "completed", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logDiagnostic("warn", "research_finished", { operation, status: "failed", durationMs: Date.now() - startedAt, errorCategory: errorCategory(error) });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function checkResearchDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new Error("Research operation time limit exceeded");
}

async function readResearchCaches(deadline: number, source?: string): Promise<CacheData[]> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(DATA_DIR)).filter((f) => /^cache_[a-z0-9_]+\.json$/i.test(f)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const target = source === undefined ? undefined : normalizeChannelInput(source);
  if (!target && files.length > 1000) throw new Error("Research source limit exceeded; specify a source");
  const caches: CacheData[] = [];
  const seenChannels = new Set<string>();
  let bytes = 0;
  let messages = 0;
  for (const file of files) {
    checkResearchDeadline(deadline);
    const fileChannel = normalizeChannelInput(file.slice(6, -5));
    if (target && fileChannel !== target) continue;
    if (seenChannels.has(fileChannel)) throw new Error(`Duplicate cache files for channel: ${fileChannel}`);
    seenChannels.add(fileChannel);
    const filePath = path.join(DATA_DIR, file);
    const stat = await fs.promises.stat(filePath);
    bytes += stat.size;
    if (bytes > RESEARCH_MAX_BYTES) throw new Error("Research cache size limit exceeded; specify a source");
    const raw = await fs.promises.readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > stat.size) throw new Error(`Cache changed while reading: ${file}`);
    checkResearchDeadline(deadline);
    let data: CacheData;
    try { data = JSON.parse(raw) as CacheData; } catch { throw new Error(`Invalid cache JSON: ${file}`); }
    if (!data || !Array.isArray(data.messages) || typeof data.channel !== "string" || normalizeChannelInput(data.channel) !== fileChannel) {
      throw new Error(`Invalid cache structure: ${file}`);
    }
    messages += data.messages.length;
    if (messages > RESEARCH_MAX_MESSAGES) throw new Error("Research message limit exceeded; specify a source");
    const ids = new Set<number>();
    for (const msg of data.messages) {
      checkResearchDeadline(deadline);
      if (!msg || !Number.isSafeInteger(msg.id) || msg.id <= 0 || typeof msg.text !== "string" || !Number.isFinite(msg.timestamp) || typeof msg.date !== "string") {
        throw new Error(`Invalid message in cache: ${file}`);
      }
      if (ids.has(msg.id)) throw new Error(`Duplicate message ID in cache: ${file}`);
      ids.add(msg.id);
      msg.channel = fileChannel;
    }
    data.channel = fileChannel;
    caches.push(data);
  }
  return caches;
}

function researchHit(msg: TelegramMessage, cache: CacheData) {
  const title = msg.text.split(/\r?\n/, 1)[0].trim().slice(0, 120) || `Telegram post ${msg.id}`;
  const cachedDate = new Date(cache.lastUpdated);
  const cachedAt = cache.lastUpdated > 0 && Number.isFinite(cachedDate.getTime()) ? cachedDate.toISOString() : null;
  return {
    pluginId: RESEARCH_PLUGIN_ID,
    itemId: `${msg.channel}/${msg.id}`,
    title,
    excerpt: formatText(msg.text, false),
    cachedAt,
    source: msg.channel,
    sourceUrl: `https://t.me/${msg.channel}/${msg.id}`,
    ...(Number.isFinite(Date.parse(msg.date)) ? { publishedAt: new Date(msg.date).toISOString() } : {}),
  };
}

// --- Tools provider ----------------------------------------------------------

export async function toolsProvider(ctl: ToolsProviderController) {
  return [
    tool({
      name: "cache_info",
      description: "Read-only research cache status (contract version 1.0).",
      parameters: {},
      implementation: async () => withResearchDeadline("cache_info", async (deadline) => {
        const caches = await readResearchCaches(deadline);
        const updated = caches.map((c) => c.lastUpdated).filter((n) => n > 0 && Number.isFinite(new Date(n).getTime()));
        return { contractVersion: RESEARCH_CONTRACT_VERSION, pluginId: RESEARCH_PLUGIN_ID, available: true, sourceCount: caches.length,
          itemCount: caches.reduce((n, c) => n + c.messages.length, 0),
          latestCachedAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null,
          freshnessNote: "Cache timestamps reflect channel sync attempts, not verified successful refreshes." };
      }),
    }),
    tool({
      name: "search_cache",
      description: "Search cached Telegram posts read-only (contract version 1.0). Source is a channel handle; since is an ISO timestamp.",
      parameters: {
        query: z.string().trim().min(1).max(256),
        limit: z.number().int().min(1).max(50).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        source: z.string().min(1).max(256).optional(),
      },
      implementation: async ({ query, limit, since, source }) => withResearchDeadline("search_cache", async (deadline) => {
        const caches = await readResearchCaches(deadline, source);
        const cutoff = since ? Date.parse(since) : -Infinity;
        const docs: Array<{ msg: TelegramMessage; tf: Map<string, number>; tokens: string[] }> = [];
        const byId = new Map<string, { msg: TelegramMessage; cache: CacheData }>();
        for (const cache of caches) for (const msg of cache.messages) {
          checkResearchDeadline(deadline);
          if (msg.timestamp < cutoff) continue;
          const tokens = tokenize(msg.text);
          docs.push({ msg, tokens, tf: buildTf(tokens) });
          byId.set(`${msg.channel}/${msg.id}`, { msg, cache });
        }
        const results = searchDocs(docs, query, limit ?? 10, deadline).map((r) => {
          const item = byId.get(`${r.channel}/${r.id}`)!;
          return { ...researchHit(item.msg, item.cache), score: Number(r.score.toFixed(4)) };
        });
        return { contractVersion: RESEARCH_CONTRACT_VERSION, results };
      }),
    }),
    tool({
      name: "get_cached_item",
      description: "Read a bounded excerpt and source details for a channel/id item (contract version 1.0).",
      parameters: { itemId: z.string().max(100).regex(/^[a-z0-9_]{3,64}\/[1-9][0-9]*$/) },
      implementation: async ({ itemId }) => withResearchDeadline("get_cached_item", async (deadline) => {
        const [channel, id] = itemId.split("/");
        const caches = await readResearchCaches(deadline, channel);
        for (const cache of caches) {
          const msg = cache.messages.find((m) => String(m.id) === id);
          if (msg) return { contractVersion: RESEARCH_CONTRACT_VERSION, item: researchHit(msg, cache) };
        }
        return { contractVersion: RESEARCH_CONTRACT_VERSION, item: null };
      }),
    }),
    tool({
      name: "telegram_fetch_channel",
      description: "Fetch recent messages from a public Telegram channel and merge them into the local RAG cache.",
      parameters: {
        channel: z.string().min(1).describe("Telegram public channel handle or t.me link"),
        maxPages: z.number().int().min(1).max(50).optional().describe("Max pages to fetch."),
        forceFullPages: z.boolean().optional().describe("Force full page scan without early stop by latestId"),
      },
      implementation: async ({ channel, maxPages, forceFullPages }) => {
        return await fetchAndCacheChannel(ctl, channel, maxPages, forceFullPages);
      },
    }),

    tool({
      name: "telegram_search",
      description: "Search the local RAG cache of a Telegram channel's messages using BM25 + IDF scoring.",
      parameters: {
        channel: z.string().min(1).describe("Telegram public channel handle or t.me link"),
        query: z.string().min(1).describe("Natural-language search query"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results."),
        fullText: z.boolean().optional().describe("Return full text without truncation"),
      },
      implementation: async ({ channel, query, limit, fullText }) => {
        const config = getConfig(ctl);
        const lim = limit ?? config.searchResultLimit;
        const windowMs = windowToMs(config.historyWindow);
        const cache = readCache(channel);
        if (cache.messages.length === 0) {
          return { channel: cache.channel, query, results: [], message: "Cache is empty." };
        }
        const results = searchInCache(cache, query, lim, windowMs);
        const full = fullText ?? false;
        return {
          channel: cache.channel,
          query,
          historyWindow: config.historyWindow,
          totalCached: cache.messages.length,
          resultCount: results.length,
          results: results.map((r) => ({
            id: r.id,
            date: r.date,
            score: Number(r.score.toFixed(4)),
            text: formatText(r.text, full),
            url: `https://t.me/${cache.channel}/${r.id}`,
          })),
        };
      },
    }),

    tool({
      name: "telegram_search_all",
      description: "Search across multiple channels (or watchlist/all cached channels) using BM25 + IDF scoring.",
      parameters: {
        query: z.string().min(1).describe("Natural-language search query"),
        channels: z.array(z.string()).optional().describe("Specific channels to search"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results."),
        fullText: z.boolean().optional().describe("Return full text without truncation"),
      },
      implementation: async ({ query, channels, limit, fullText }) => {
        const config = getConfig(ctl);
        const lim = limit ?? config.searchResultLimit;
        const windowMs = windowToMs(config.historyWindow);
        let targetChannels: string[] = [];
        if (channels && channels.length > 0) {
          targetChannels = channels
            .map((c) => {
              try {
                return normalizeChannelInput(c);
              } catch {
                return "";
              }
            })
            .filter((c) => c.length >= 3);
        } else {
          const wl = readWatchlist();
          if (wl.length > 0) {
            targetChannels = wl;
          } else {
            ensureDataDir();
            const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("cache_") && f.endsWith(".json"));
            for (const f of files) {
              try {
                const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
                const data = JSON.parse(raw) as CacheData;
                if (data.channel) {
                  targetChannels.push(normalizeChannelInput(data.channel));
                }
              } catch {}
            }
          }
        }
        const uniqueTargets = Array.from(new Set(targetChannels));
        const caches: CacheData[] = [];
        for (const ch of uniqueTargets) {
          try {
            const c = readCache(ch);
            if (c.messages.length > 0) caches.push(c);
          } catch {}
        }
        const results = searchInCacheAll(caches, query, lim, windowMs);
        const full = fullText ?? false;
        return {
          query,
          totalChannelsSearched: caches.length,
          resultCount: results.length,
          results: results.map((r) => ({
            channel: r.channel,
            id: r.id,
            date: r.date,
            score: Number(r.score.toFixed(4)),
            text: formatText(r.text, full),
            url: `https://t.me/${r.channel}/${r.id}`,
          })),
        };
      },
    }),

    tool({
      name: "telegram_watchlist_add",
      description: "Add a Telegram channel to the watchlist.json file for regular syncing.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel handle or t.me link") },
      implementation: async ({ channel }) => {
        const list = readWatchlist();
        const ch = normalizeChannelInput(channel);
        if (!list.includes(ch)) {
          list.push(ch);
          writeWatchlist(list);
          return { channel: ch, added: true, totalChannels: list.length };
        }
        return { channel: ch, added: false, message: "Already in watchlist.", totalChannels: list.length };
      },
    }),

    tool({
      name: "telegram_watchlist_remove",
      description: "Remove a Telegram channel from the watchlist.json file.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel handle or t.me link") },
      implementation: async ({ channel }) => {
        const list = readWatchlist();
        const ch = normalizeChannelInput(channel);
        const newList = list.filter((c) => c !== ch);
        if (newList.length === list.length) return { channel: ch, removed: false, message: "Not found in watchlist." };
        writeWatchlist(newList);
        return { channel: ch, removed: true, totalChannels: newList.length };
      },
    }),

    tool({
      name: "telegram_watchlist_sync",
      description: "Fetch and update the RAG cache for ALL channels listed in watchlist.json.",
      parameters: {
        forceFullPages: z.boolean().optional().describe("Force full page scan without early stop by latestId"),
      },
      implementation: async ({ forceFullPages }) => {
        const list = readWatchlist();
        if (list.length === 0) return { message: "Watchlist is empty." };
        const results: Record<string, unknown>[] = [];
        for (const channel of list) {
          const res = await fetchAndCacheChannel(ctl, channel, undefined, forceFullPages);
          results.push(res);
          await sleep(500);
        }
        return { totalChannels: list.length, results };
      },
    }),

    tool({
      name: "telegram_cache_stats",
      description: "Return statistics about the local message cache for a Telegram channel.",
      parameters: { channel: z.string().min(1).describe("Telegram public channel handle or t.me link") },
      implementation: async ({ channel }) => {
        const cache = readCache(channel);
        const config = getConfig(ctl);
        const windowMs = windowToMs(config.historyWindow);
        const cutoff = Date.now() - windowMs;
        const inWindow = cache.messages.filter((m) => m.timestamp >= cutoff).length;
        return {
          channel: cache.channel,
          historyWindow: config.historyWindow,
          totalCached: cache.messages.length,
          inWindow,
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
        channel: z.string().min(1).describe("Telegram public channel handle or t.me link"),
        count: z.number().int().min(1).max(50).optional().describe("Number of messages. Default 10."),
        fullText: z.boolean().optional().describe("Return full text without truncation"),
      },
      implementation: async ({ channel, count, fullText }) => {
        const n = count ?? 10;
        const cache = readCache(channel);
        if (cache.messages.length === 0) return { channel: cache.channel, messages: [], message: "Cache is empty." };
        const recent = cache.messages.slice(-n).reverse();
        const full = fullText ?? false;
        return {
          channel: cache.channel,
          count: recent.length,
          messages: recent.map((m) => ({
            id: m.id,
            date: m.date,
            text: formatText(m.text, full),
            url: `https://t.me/${cache.channel}/${m.id}`,
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
            const ch = data.channel || f.replace("cache_", "").replace(".json", "");
            channels.push({
              channel: ch,
              messageCount: data.messages?.length || 0,
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
      parameters: { channel: z.string().min(1).describe("Telegram public channel handle or t.me link") },
      implementation: async ({ channel }) => {
        const ch = normalizeChannelInput(channel);
        const p = getCachePath(ch);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          return { channel: ch, cleared: true };
        }
        return { channel: ch, cleared: false, message: "No cache file found." };
      },
    }),

    tool({
      name: "telegram_ping",
      description: "Health check. Returns plugin status and the data directory.",
      parameters: {},
      implementation: async () => {
        ensureDataDir();
        const cachedChannels = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith("cache_") && f.endsWith(".json")).length;
        return {
          status: "ok",
          plugin: PLUGIN_NAME,
          dataDirectory: DATA_DIR,
          cachedChannels,
        };
      },
    }),
  ];
}
