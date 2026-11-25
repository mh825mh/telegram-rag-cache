# Telegram RAG Cache: fix and improvement plan

Log review: 25 November 2026. Scope: plugin-identified entries in the November LM Studio server logs, with closer inspection of 24–25 November. These logs may not capture every plugin failure or tool result.

## Findings

- **Observed — tool access denied:** On 25 November at 04:27:11, 04:27:35, and 04:29:40, LM Studio rejected `startToolUseSession` because the requesting clients lacked `plugins.use` permission for `mh825/telegram-rag-cache`. The plugin registered its tools provider at 04:24:21 and again later. Registration does not prove that any client can use it. The logs do not establish which application owns the requesting clients or why permission was missing.
- **Observed — dependency mismatch:** `npm ls --depth=0` reports installed TypeScript 7.0.2 as invalid for the `^5.7.2` range in `package.json`; the lockfile root also declares `^7.0.2`. A prior type-check passed using that unsupported installed version, so it is not a clean verification of the declared setup.
- **Observed — old cache files:** The plugin data directory contains cache files last modified on 16 October 2026 or earlier. This alone does not prove sync failed: sync may not have been requested, and configured data paths or installations may differ.
- **Code risk — silent storage failures:** `readCache` and `readWatchlist` treat parsing and read errors as empty data. A subsequent write can overwrite data that could otherwise be recovered.
- **Code risk — ambiguous sync status:** A sync updates `lastUpdated` and writes a cache even when the first fetch fails. If a parse anomaly and fetch error both occur, the anomaly warning overrides the error warning. These are code observations, not failures established by the logs.
- **Code risk — legacy filenames:** Some existing cache filenames contain uppercase letters, while channel names are normalized to lowercase. Windows normally resolves filenames case-insensitively; case-sensitive filesystems or directories can make those legacy files inaccessible. Verify behavior before migrating anything.

## Prioritized work

1. **Restore authorized tool use.** Identify the clients associated with the denied sessions, inspect their LM Studio plugin access and configuration, and grant the intended client access through LM Studio's supported permission flow. Avoid broadening access for unrelated clients. Re-run `telegram_ping` from the same client and verify that a tool session starts without a permission error. If denial persists, capture a fresh timestamp and inspect the matching authenticator events.
2. **Make installs reproducible.** Regenerate the lockfile using the TypeScript range in `package.json`, perform a clean `npm ci` in a safe environment, then run `npm ls --depth=0` and `npm run typecheck`. Confirm the lockfile and installed version satisfy the declared range. Registry access may be needed.
3. **Prevent accidental data loss.** Distinguish missing files from malformed JSON, invalid schema, and I/O errors. Report actionable errors and prevent cache or watchlist writes after an unsuccessful read; preserve original files for recovery. Add tests that verify corrupted and unreadable data is never overwritten.
4. **Report sync outcomes accurately.** Track last attempt separately from last successful sync, preserve all warnings, and distinguish full success, partial success, and failure. Define whether partial pages are saved, and test first-page failures, later-page failures, empty responses, and parser anomalies.
5. **Add regression coverage.** Create fixture-based tests for public Telegram HTML, replies, media, malformed entities, pagination, normalization, multilingual search, and storage. Add a repeatable test command and run it alongside type-checking in CI.
6. **Review legacy cache compatibility.** Test mixed-case filenames on case-sensitive and case-insensitive filesystems. If migration is needed, detect collisions, preserve existing files, and use an explicit, tested migration rather than overwriting either copy.
7. **Improve operational visibility.** Add concise, privacy-conscious diagnostics for attempted and successful syncs, channel, page counts, and error category without logging message contents. Provide a health/status view that exposes last successful sync and cache freshness.
8. **Validate end to end.** With an authorized client and a public test channel, run ping, fetch, stats, search, and a second incremental sync; confirm results and logs, then verify failures are visible without damaging existing data. Document results and any network or permission limitations.

## Suggested follow-ups

- Guard numeric HTML entities against invalid Unicode code points so a malformed entity cannot abort an entire page.
- Add an explicit refresh/backfill strategy for edited messages and gaps: the current incremental stop can skip older changes; test the existing `forceFullPages` option against those cases.
- Document the permission troubleshooting path once the affected client and working access flow are confirmed.

## Local research integration

Progress (25 November 2026): the three version 1.0 tools now read the existing JSON cache; fixture tests cover basic ranking, filters, stable links, bounds, input validation and corrupt JSON. Existing Telegram readers and writers have not been switched. A development provider registered with LM Studio, but an SDK tool-session attempt was denied `plugins.use`, so no calls were verified through a live session. On the local cache, nine JSON files totalled 4,739,315 bytes and contained 4,463 records; one direct in-process `technology` search took 369.8 ms (single un-warmed measurement). Host Node 26 supports `node:sqlite` with FTS5; the LM Studio plugin runtime has not been verified. No database has been migrated, so after-migration disk use, latency, migration checks and rollback checks are not yet available.

Release preparation: the TypeScript dependency and lockfile have been aligned, and privacy-conscious structured diagnostics now record research operation outcomes and sync summaries. The remaining storage, migration, permission, and live-session work remains open.

1. Add versioned, bounded, read-only `cache_info`, `search_cache`, and `get_cached_item` tools to the existing LM Studio provider, reusing the JSON cache and BM25 ranking. Keep refresh and writes in the existing tools. Test the contract, filters, stable IDs, error reporting, and limits without touching the user's cache.
2. Determine the Node runtime and SQLite/FTS5 capabilities actually shipped by LM Studio before selecting a storage implementation. This repository currently has no SQLite database or local adapter. Prototype an owned SQLite store with queryable identifiers, links, timestamps and filters, compressing bodies only when gzip saves space.
3. Implement a resumable, idempotent migration into a separate database, preserving JSON for rollback. Check counts, content, links and representative searches, measure disk use and latency, and verify synchronization and rollback before switching any existing readers. Avoid representing unverified migration or performance work as complete.
4. Verify the three read-only calls in a live authorized LM Studio session, document exact plugin and tool names and limitations, and report any permission or runtime blockers. The previously observed permission denials may need resolution first.
