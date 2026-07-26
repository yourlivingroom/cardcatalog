# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@livingroom/cardcatalog` is a file-watching directory indexer library. The entire implementation is `index.mjs` (a single default-exported factory function). `scratch/` is a gitignored directory for hacky dev scripts and their runtime data; `scratch/hack.mjs` is a demo script showing usage, with its `db/` and `index/` data living alongside it in `scratch/`.

## Commands

- Smoke test / demo: `node scratch/hack.mjs` (watches `scratch/db`, builds a word index in `scratch/index`, queries for "foo")
- Debug logging: set `CARDCATALOG_DEBUG=1` to enable per-document index bookkeeping output
- Test: `npm test` (node:test over `test/`); single file: `node --test test/cardcatalog.test.mjs`; single test: add `--test-name-pattern="<name>"`
- Coverage: `npm run coverage` (c8, enforces 100% on every metric via `--100`; `tools/coverage-badge.mjs` renders `coverage/coverage-summary.json` as an SVG badge, published by CI to the `badges` branch). The `CARDCATALOG_DEBUG` branch binds `console.log` at module load, which is why `test/debug-logging.test.mjs` is a separate file — it needs its own process to set the env var and stub the logger before import.
- Typecheck: `npm run typecheck` (tsc --noEmit over `index.d.mts` + `test-d/index.test-d.ts`)
- Format: `npm run format` (prettier; check-only via `npm run format:check`)
- Lint: `npm run lint` (eslint, zero warnings tolerated; `npx eslint . --fix` autofixes import order)

Import style is enforced, not conventional: whole-module (default) imports first, then destructuring (named) ones, each block alphabetized by module name with a blank line between (`perfectionist/sort-imports`), and no imports below the first statement (`local/imports-first`, a ~15-line rule defined inline in `eslint.config.mjs`). Sorting is by module name, not local binding, so e.g. `p-queue` precedes `path`. The imports-first rule is local rather than `eslint-plugin-import-x` on purpose: import-x drags in a native resolver whose per-platform optional dependencies npm records differently depending on where `npm install` ran, which broke `npm ci` on every CI job.

## Testing approach

Tests run against real temp directories (`fs.mkdtemp`) rather than a mock fs — chokidar's native watchers don't see fake filesystems (mock-fs explicitly doesn't support `fs.watch`). Watcher-driven assertions poll via the `eventually()` helper; most tests use `reindex()` instead for determinism. Each test's `t.after` closes the catalog — `close()` drains the queue and closes the LevelDB handles, which is what lets the test process exit.

## Types

Hand-written `index.d.mts` (`.d.mts`, not `.d.ts` — node16 resolution pairs declarations to `index.mjs` by extension). Checked three ways, all of which must stay in place for the types to mean anything:

1. `test-d/index.test-d.ts` — compile-time assertions via an `Expect<Equal<>>` helper plus ts-expect-error for negative cases (an unused directive is itself an error, so negatives can't silently stop testing). It lives in `test-d/`, NOT `test/`: Node's test runner treats every file under `test/` as a test file, and Node 22+ strips TypeScript natively, so it would be _executed_ — and its deliberately-invalid calls throw at runtime.
2. `skipLibCheck` is deliberately **false** in tsconfig: with it on, errors inside `index.d.mts` are only caught where a test happens to touch them.
3. Runtime surface tests in `cardcatalog.test.mjs` (`runtime surface matches the type declarations`, plus the `Problem`/event payload shape tests) enumerate actual object keys — the only guard against declarations drifting from the implementation, which no amount of type-level testing can catch.

`IndexConfig` is covariant in its value type, so the generic bound is `IndexConfig<any>` (`AnyIndexConfig`); `ValueOf` maps an inferred `any` back to `unknown` so unannotated configs never silently produce `any`.

## Architecture

`cardcatalog(indexes, opts)` takes a map of named index configs and returns an EventEmitter with `{ indexes, close, reindex, dataPath, indexPath }`. `catalogs` is a deprecated alias for `indexes` (non-enumerable getter, warns once per process) kept for backward compatibility — do not use it in new code or docs.

Config is validated fail-fast at the top of the factory, before any directory or database is created. Index names become directory names under indexPath, so separators, `.`/`..`, and empty names are rejected.

Error discipline: every failure has exactly one owner. Document-level `process()` throws → quarantine + `'problem'` event (never `'error'`). `reindex()` failures → reject the caller's promise (never also emitted). Watcher-driven infrastructure failures and chokidar `'error'`s → the catalog's `'error'` event, with standard unhandled-throws semantics. A file vanishing between event and read (ENOENT) is silently skipped — the unlink event handles cleanup. p-queue re-emits task rejections as its own `'error'` events, but it uses eventemitter3 (inert when unlistened), so no queue-level listener exists or is needed.

The catalog emits `'idle'` whenever it goes fully quiescent: the initial sweep has finished enumerating AND the work queue has drained. The queue draining mid-sweep deliberately doesn't count (chokidar is still finding files), so the first `'idle'` doubles as a ready signal — `await once(catalog, 'idle')` guarantees every pre-existing document is queryable. It fires again after each later batch of changes is folded in.

Data flow: chokidar watches `opts.dataPath` (default `./db`). File add/change/unlink events are pushed through a p-queue (concurrency 5) into `updatePath()` — different files run in parallel, but updates to the same file are chained (`fileTails`) so their read-fileMeta/write-batch cycles can't interleave and orphan index keys. `updatePath()` runs the user-supplied `process(fileContent, emit, { path })` for each index. Each `emit(key, value)` becomes a LevelDB entry whose key is `[...emittedKey, filePath]` (charwise-encoded), so a range scan from `[...queryKey, null]` to `[...queryKey, undefined]` finds all files that emitted a given key — that's how `indexes.<name>.getMany(key)` works. `get(key)` is `getMany` that throws on multiple matches. `getRange({ gt, gte, lt, lte, reverse, limit })` maps each bound through the same sentinel trick, so bounds inherit prefix semantics — a bound addresses a key's whole subtree (gte/lte include it, gt/lt skip past it); omitted bounds are open ends and `getRange({})` scans the whole index in charwise order. `reverse` walks high-to-low; `limit` caps yielded entries (counted per emitted entry, not per distinct key) and applies after reversal, so `{reverse: true, limit: n}` is "last n".

Each named index is its own `ClassicLevel` database under `opts.indexPath/<name>`, with four sublevels:

- `index` — emitted key → emitted value (valueEncoding from the index config, default utf8)
- `reverseIndex` — emitted key → file path (used to clean up a file's old entries on reindex)
- `fileMeta` — file path → `{ indexKeys, updatedAt, failed? }`; `updatedAt` (from mtime) lets unchanged files be skipped, but `failed` defeats that skip so quarantined documents stay retryable via `reindex()` or the next startup sweep
- `problemDocuments` — file path → `{ at, message, stack }` when `process()` throws; written in the same batch that clears the document's cards (quarantine is atomic — partial emissions are discarded), cleared on success, exposed via `indexes.<name>.problems()`. The catalog emits `'problem'` ({ index, path, error }, each failure) and `'resolved'` ({ index, path }, on successful reindex or removal of a quarantined document)

All deletions of old keys and insertions of new ones for a file happen in a single `batch()`, so an index update is atomic per file per index.

`reindex(path)` means "this document changed — do the usual thing for it, now": identical handling to a watcher event, `shouldIndex` included, just without waiting for the watcher. It goes through the same queue, so it can't race watcher-driven updates. A missing file is treated as removal. Resolves `true` if the document was processed, `false` if `shouldIndex` filtered it out. Because reindex no longer bypasses the filter, tests that need the watcher silenced use `chokidar: { ignored: () => true }` (the `NO_WATCH` helper) rather than a false `shouldIndex`.

Path identity: documents are keyed everywhere — index keys, fileMeta, `shouldIndex`, `process`'s context, query results — by their dataPath-relative path, computed lexically (`path.resolve`/`path.relative`, never `realpath`) and separator-normalized to `/` on every platform (`toRelPath` is the single boundary), so index databases are portable across operating systems. Nothing absolute is persisted anywhere (index keys, fileMeta, reverseIndex, problemDocuments), so an app directory can be moved or renamed wholesale without invalidating its indexes — pinned by the `an index survives moving the whole app directory` test, which asserts zero re-processing after the move. Physical canonicalization is deliberately avoided: it needs search permission on every ancestor directory and fails with ENOENT on deleted files, which is exactly the remove case. `reindex()` accepts relative (to dataPath) or absolute spellings, normalizes them to the same identity, and rejects paths outside dataPath.

Gotchas encoded in the source:

- `KEY_BOTTOM`/`KEY_TOP` are locally defined as `null`/`undefined` because the npm release of charwise doesn't export its LO/HI sentinels. `undefined` is consequently rejected anywhere in emitted keys, query keys, and range bounds (`assertNoUndefined`) — it sorts at the edge of every subtree range and would silently escape prefix queries. `null` is fine: it's the LOW sentinel, and keys containing it still fall inside range bounds.
- `opts.dataPath` is `mkdirSync`'d before watching because chokidar won't reliably see files created in a directory that didn't exist when the watch began.
- On win32 the watch root is `realpathSync.native`'d once after creation — libuv's fs-event watcher asserts (native crash) when the watched root uses an 8.3 short name (like GH runners' `RUNNER~1` temp dir). Root-only exception to the no-realpath rule; per-document paths stay lexical. The block is c8-ignored since it's unreachable off-Windows.
- `opts.chokidar` is passed verbatim to `chokidar.watch`. `awaitWriteFinish` is deliberately NOT defaulted on: it holds initial-scan add events past chokidar's `'ready'`, which would make the first `'idle'` fire before pre-existing documents are indexed.

Query results yield `{ key, path, indexValue, read(), readSync() }` where `path` is relative to `dataPath` but the read functions use the absolute path internally.
