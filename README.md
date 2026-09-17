# Telegram RAG Cache (LM Studio Plugin)

A lightweight LM Studio plugin that fetches, caches, and performs lexical RAG (Retrieval-Augmented Generation) search over public Telegram channel messages.

It uses Telegram's public web preview (`t.me/s/<channel>`), so no API keys or authentication are required. Messages are cached locally as pure JSON files, and search is powered by a custom TF-IDF cosine similarity implementation.

## Features

- **No API Keys:** Scrapes public Telegram web previews.
- **Local JSON Caching:** Stores messages in `~/.lmstudio/plugin-data/telegram-rag-cache/`. No external databases required.
- **Configurable History Windows:** Cache 1 week, 1 month, 3, 6, 9, 12, or 24 months of history.
- **Lexical RAG Search:** Term-frequency vectors with cosine similarity, plus exact-substring bonuses.
- **Watchlist Automation:** Maintain a channel list and sync everything with a single command.
- **Minimal Dependencies:** Runtime logic uses only Node.js built-ins (`fs`, `path`, `os`, `https`); schema validation uses `zod` via the LM Studio SDK.

## Configuration

In LM Studio, open the plugin settings to configure:

| Setting | Description | Default |
| --- | --- | --- |
| History Window | How far back to cache and search | 1 Month |
| Max Cached Messages | Upper bound on messages stored on disk per channel | 5,000 |
| Default Fetch Pages | Pages to fetch per sync (~20 messages/page) | 5 |
| Search Result Limit | Maximum number of search results returned | 10 |

## Available Tools

| Tool Name | Description |
| --- | --- |
| `telegram_fetch_channel` | Fetches recent messages for a channel and merges them into the local cache. |
| `telegram_search` | Searches the local cache using cosine similarity over term-frequency vectors. |
| `telegram_watchlist_add` | Adds a channel to `watchlist.json` for regular syncing. |
| `telegram_watchlist_remove` | Removes a channel from the watchlist. |
| `telegram_watchlist_sync` | Fetches and updates the cache for every channel in the watchlist. |
| `telegram_cache_stats` | Returns statistics (total cached, in-window count, date range) for a channel. |
| `telegram_get_recent` | Returns the most recent N cached messages for a channel. |
| `telegram_list_channels` | Lists all channels that have cached data on disk. |
| `telegram_clear_cache` | Deletes the local cache file for a specific channel. |
| `telegram_ping` | Health check. Returns plugin status and the data directory. |

## Usage Examples

Just talk to your LLM in LM Studio. Make sure the plugin is enabled in the Tools menu.

**Setting up a watchlist**

> "Please add the channels `durov` and `telegram` to my Telegram watchlist."

**Syncing data**

> "Sync my Telegram watchlist now."

The LLM fetches every channel in `watchlist.json` and caches their messages.

**Searching (RAG)**

> "Search the `durov` channel for messages about AI or technology."

The LLM searches the local cache and returns the most relevant messages with direct `t.me` links.

**Checking stats**

> "Show me the cache stats for the `telegram` channel."

## Data Storage

- **Cache Files:** `~/.lmstudio/plugin-data/telegram-rag-cache/cache_<channel>.json`
- **Watchlist:** `~/.lmstudio/plugin-data/telegram-rag-cache/watchlist.json`

## Development

This plugin adheres to the LM Studio SDK architecture rules:

- `src/index.ts` entry point exporting `async function main(context)`.
- No `"type": "module"` in `package.json` (bundles to CommonJS).
- `manifest.json` contains only `type`, `runner`, `owner`, `name`, `description`, `revision`.
- Config UI uses `createConfigSchematics` with only `select` or `numeric` fields.
- Tools use the `tool()` helper with plain Zod object parameters.
- HTML parsing and JSON storage use bundled code only (no parser/DB dependencies).
- Uses `__dirname` / `os.homedir()` instead of `import.meta.url`.

### Building and type-checking

Install dependencies and type-check:

```sh
npm install
npm run typecheck
```