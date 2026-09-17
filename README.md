Telegram RAG Cache (LM Studio Plugin)

A zero-dependency LM Studio plugin that fetches, caches, and performs lexical RAG (Retrieval-Augmented Generation) search over public Telegram channel messages. 

It uses Telegram's public web preview (t.me/s/<channel>), so no API keys or authentication are required. Messages are cached locally as pure JSON files, and search is powered by a custom TF-IDF cosine similarity implementation.
Features

    No API Keys: Scrapes public Telegram web previews.
    Local JSON Caching: Stores messages in ~/.lmstudio/plugin-data/telegram-rag-cache/. No external databases required.
    Configurable History Windows: Choose to cache 1 week, 1 month, 3, 6, 9, 12, or 24 months of history.
    Lexical RAG Search: Uses term-frequency vectors and cosine similarity to find relevant messages, plus exact substring bonuses.
    Watchlist Automation: Maintain a list of channels and sync them all with a single command.
    Zero External Dependencies: Uses only Node.js built-in modules (fs, path, os, https) and zod for schema validation.

Configuration

In LM Studio, go to the plugin settings to configure:

    History Window: How far back to cache and search (default: 1 Month).
    Max Cached Messages: Upper bound on messages stored on disk per channel (default: 5,000).
    Default Fetch Pages: How many pages to fetch per sync (default: 5 pages, ~100 messages).
    Search Result Limit: Maximum number of search results returned (default: 10).

Available Tools
Tool Name	Description
telegram_fetch_channel	Fetches recent messages for a specific channel and merges them into the local cache.
telegram_search	Searches the local cache using cosine similarity over term-frequency vectors.
telegram_watchlist_add	Adds a channel to watchlist.json for regular syncing.
telegram_watchlist_remove	Removes a channel from the watchlist.
telegram_watchlist_sync	Fetches and updates the cache for ALL channels in the watchlist.
telegram_cache_stats	Returns statistics (total cached, in-window count, date range) for a channel.
telegram_get_recent	Returns the most recent N cached messages for a channel.
telegram_list_channels	Lists all channels that currently have cached data on disk.
telegram_clear_cache	Deletes the local cache file for a specific channel.
telegram_ping	Health check. Returns plugin status and data directory.
Usage Examples

Just talk to your LLM in LM Studio! Make sure the plugin is enabled in the Tools menu.

Setting up a watchlist:

    "Please add the channels 'durov' and 'telegram' to my Telegram watchlist."

Syncing data:

    "Sync my Telegram watchlist now."(The LLM will fetch all channels in your watchlist.json and cache their messages.)

Searching (RAG):

    "Search the 'durov' channel for messages about AI or technology."(The LLM will search the local cache and return the most relevant messages with direct t.me links.)

Checking Stats:

    "Show me the cache stats for the 'telegram' channel."

Data Storage

    Cache Files: ~/.lmstudio/plugin-data/telegram-rag-cache/cache_<channel>.json
    Watchlist: ~/.lmstudio/plugin-data/telegram-rag-cache/watchlist.json

Development Rules Followed

This plugin strictly adheres to LM Studio SDK architecture rules:

    src/index.ts entry point exporting async function main(context).
    No "type": "module" in package.json (bundles to CommonJS).
    manifest.json contains only type, runner, owner, name, description, revision.
    Config UI uses createConfigSchematics with only "select" or "numeric" fields.
    Tools use the tool() helper with plain Zod object parameters.
    Zero external npm dependencies for parsing/DB (custom regex and pure JS JSON wrappers).
    Uses __dirname / os.homedir() instead of import.meta.url.