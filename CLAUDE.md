# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@livingroom/cardcatalog` is a file-watching directory indexer library. The entire implementation is `index.mjs` (a single default-exported factory function). `scratch/` is a gitignored directory for hacky dev scripts and their runtime data; `scratch/hack.mjs` is a demo script showing usage, with its `db/` and `index/` data living alongside it in `scratch/`.

## Commands

- Smoke test / demo: `node scratch/hack.mjs` (watches `scratch/db`, builds a word index in `scratch/index`, queries for "foo")
- Debug logging: set `CARDCATALOG_DEBUG=1` to enable per-document index bookkeeping output
- There are no tests and no linter (`npm test` is the placeholder that exits 1)

## Architecture

`cardcatalog(indexes, opts)` takes a map of named index configs and returns `{ catalogs, close, reindex, dataPath, indexPath }`.

Data flow: chokidar watches `opts.dataPath` (default `./db`). File add/change/unlink events are pushed through a p-queue (concurrency 5) into `updatePath()`, which for each index runs the user-supplied `process(fileContent, emit, { path })`. Each `emit(key, value)` becomes a LevelDB entry whose key is `[...emittedKey, filePath]` (charwise-encoded), so a range scan from `[...queryKey, null]` to `[...queryKey, undefined]` finds all files that emitted a given key — that's how `catalogs.<name>.getMany(key)` works. `get(key)` is `getMany` that throws on multiple matches.

Each named index is its own `ClassicLevel` database under `opts.indexPath/<name>`, with four sublevels:

- `index` — emitted key → emitted value (valueEncoding from the index config, default utf8)
- `reverseIndex` — emitted key → file path (used to clean up a file's old entries on reindex)
- `fileMeta` — file path → `{ indexKeys, updatedAt }`; `updatedAt` (from mtime) lets unchanged files be skipped
- `problemDocuments` — file path → error details when `process()` throws; cleared on successful reindex

All deletions of old keys and insertions of new ones for a file happen in a single `batch()`, so an index update is atomic per file per index.

`reindex(path)` lets a writer force immediate indexing instead of waiting for the watcher; it goes through the same queue, so it can't race watcher-driven updates. A missing file is treated as removal.

Gotchas encoded in the source:

- `KEY_BOTTOM`/`KEY_TOP` are locally defined as `null`/`undefined` because the npm release of charwise doesn't export its LO/HI sentinels.
- `opts.dataPath` is `mkdirSync`'d before watching because chokidar won't reliably see files created in a directory that didn't exist when the watch began.

Query results yield `{ key, path, indexValue, read(), readSync() }` where `path` is relative to `dataPath` but the read functions use the absolute path internally.
