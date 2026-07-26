import { EventEmitter } from 'events';

import charwise from 'charwise';
import chokidar from 'chokidar';
import fs from 'fs';
import pathLib from 'path';
import PQueue from 'p-queue';

// npm release of charwise seems not to expose these
const KEY_BOTTOM = null;
const KEY_TOP = undefined;

import { ClassicLevel } from 'classic-level';

// Per-document index bookkeeping is verbose; keep it off unless debugging.
const debug = process.env.CARDCATALOG_DEBUG
    ? console.log.bind(console)
    : () => {};

// The `catalogs` deprecation warning fires once per process, not per catalog.
let warnedCatalogs = false;

// Windows reports EPERM for files in a delete-pending state — the file is
// gone for practical purposes, but a handle (often the watcher's own) has
// yet to close. Retry with backoff: a pending delete becomes ENOENT, which
// callers already treat as removal, while a real permission problem stays
// EPERM and propagates.
async function retryingEperm(op) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await op();
        } catch (e) {
            if (e.code !== 'EPERM' || attempt >= 5) {
                throw e;
            }
            await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
        }
    }
}

function shallowMerge(o1, o2) {
    const result = {};

    for (const [k, v] of Object.entries(o1)) {
        if (v !== undefined) {
            result[k] = v;
        }
    }

    for (const [k, v] of Object.entries(o2)) {
        if (v !== undefined) {
            result[k] = v;
        }
    }

    return result;
}

// undefined is charwise's highest-sorting value, which is exactly why it's
// our KEY_TOP range sentinel — a key containing it would sort at the edge of
// every subtree range and silently escape prefix queries. Reject it anywhere
// in a key rather than let that happen.
function assertNoUndefined(key, what) {
    if (key === undefined) {
        throw new TypeError(
            what +
                ' must not contain undefined — it is reserved as the ' +
                'range-scan sentinel',
        );
    }

    if (Array.isArray(key)) {
        for (const element of key) {
            assertNoUndefined(element, what);
        }
    }
}

function validateIndexes(indexes) {
    if (typeof indexes !== 'object' || indexes === null) {
        throw new TypeError(
            'indexes must be an object mapping index names to configs',
        );
    }

    for (const [name, config] of Object.entries(indexes)) {
        if (
            name === '' ||
            name === '.' ||
            name === '..' ||
            /[/\\]/.test(name)
        ) {
            throw new TypeError(
                'invalid index name ' +
                    JSON.stringify(name) +
                    ': index names become directory names under indexPath',
            );
        }

        if (typeof config?.process !== 'function') {
            throw new TypeError(
                'index ' + JSON.stringify(name) + ' needs a process function',
            );
        }
    }
}

function validateOpts(opts) {
    if (typeof opts.dataPath !== 'string') {
        throw new TypeError('opts.dataPath must be a string');
    }
    if (typeof opts.indexPath !== 'string') {
        throw new TypeError('opts.indexPath must be a string');
    }
    if (typeof opts.shouldIndex !== 'function') {
        throw new TypeError('opts.shouldIndex must be a function');
    }
    if (typeof opts.chokidar !== 'object' || opts.chokidar === null) {
        throw new TypeError('opts.chokidar must be an object');
    }
}

export default function cardcatalog(indexes, opts = {}) {
    validateIndexes(indexes);

    opts = shallowMerge(
        {
            dataPath: './db',
            indexPath: './index',
            shouldIndex: () => true,
            chokidar: {},
        },
        opts,
    );
    validateOpts(opts);

    // Documents are identified everywhere — index keys, fileMeta, the public
    // API — by their dataPath-relative path, computed lexically. Physical
    // canonicalization (realpath) is deliberately avoided: it needs search
    // permission on every ancestor directory and fails outright on deleted
    // files, which is exactly the remove case.
    opts.dataPath = pathLib.resolve(opts.dataPath);

    // Relative inputs are taken as dataPath-relative already; absolute ones
    // are made relative. Both lexically. Separators are normalized to '/' on
    // every platform so index keys — and therefore whole index databases —
    // are portable between operating systems.
    function toRelPath(path) {
        return pathLib
            .relative(opts.dataPath, pathLib.resolve(opts.dataPath, path))
            .split(pathLib.sep)
            .join('/');
    }

    function toAbsPath(relPath) {
        return pathLib.join(opts.dataPath, relPath);
    }

    const indexDbs = Object.fromEntries(
        Object.entries(indexes).map(([k]) => [
            k,
            new ClassicLevel(pathLib.join(opts.indexPath, k)),
        ]),
    );

    async function updatePath(relPath, remove, stats) {
        let fileContent;
        if (!remove) {
            try {
                fileContent = await retryingEperm(() =>
                    fs.promises.readFile(toAbsPath(relPath)),
                );
            } catch (e) {
                if (e.code === 'ENOENT') {
                    // The file vanished between the event and us reading it.
                    // Not an error: the watcher's unlink event will (or
                    // already did) clean up.
                    debug('Skipping vanished file', relPath);
                    return;
                }
                throw e;
            }
        }

        for (const k of Object.keys(indexes)) {
            const indexConfig = indexes[k];

            const fileMeta =
                (await indexDbs[k]
                    .sublevel('fileMeta')
                    .get(relPath, { valueEncoding: 'json' })) ?? {};

            if (
                !remove &&
                !fileMeta.failed &&
                fileMeta.updatedAt &&
                fileMeta.updatedAt >= new Date(stats.mtimeMs).toISOString()
            ) {
                debug('For index ' + k + ' skipping ' + relPath + '.');
                continue;
            }

            const emitted = [];
            let failure = null;

            if (!remove) {
                try {
                    await indexes[k].process(
                        fileContent,
                        (k, v) => {
                            assertNoUndefined(k, 'emitted key');
                            emitted.push([buildKey(relPath, k), v]);
                        },
                        { path: relPath },
                    );
                } catch (e) {
                    // Quarantine is all-or-nothing: cards emitted before the
                    // throw are discarded, and the problem record is written
                    // as part of the same batch that clears the document's
                    // old cards.
                    failure = e;
                    emitted.length = 0;
                }
            }

            debug('\nFor index ' + k + ' updating ' + relPath + '.');
            debug('Deleting', fileMeta.indexKeys ?? []);
            debug('Emitting', emitted);

            const indexSublevel = await indexDbs[k].sublevel('index');
            const reverseIndexSublevel =
                await indexDbs[k].sublevel('reverseIndex');
            const fileMetaSublevel = await indexDbs[k].sublevel('fileMeta');
            const problemDocumentsSublevel =
                await indexDbs[k].sublevel('problemDocuments');

            const oldKeys = fileMeta.indexKeys ?? [];

            await indexDbs[k].batch([
                ...oldKeys.map((key) => ({
                    type: 'del',
                    sublevel: indexSublevel,
                    key,
                    keyEncoding: charwise,
                })),
                ...oldKeys.map((key) => ({
                    type: 'del',
                    sublevel: reverseIndexSublevel,
                    key,
                    keyEncoding: charwise,
                })),
                ...emitted.map(([key, value]) => ({
                    type: 'put',
                    sublevel: indexSublevel,
                    key,
                    value,
                    keyEncoding: charwise,
                    valueEncoding: indexConfig.valueEncoding ?? 'utf8',
                })),
                ...emitted.map(([key]) => ({
                    type: 'put',
                    sublevel: reverseIndexSublevel,
                    key,
                    value: relPath,
                    keyEncoding: charwise,
                    valueEncoding: 'utf8',
                })),
                failure
                    ? {
                          type: 'put',
                          sublevel: problemDocumentsSublevel,
                          key: relPath,
                          value: {
                              at: new Date().toISOString(),
                              message: failure.message,
                              stack: failure.stack,
                          },
                          valueEncoding: 'json',
                      }
                    : {
                          type: 'del',
                          sublevel: problemDocumentsSublevel,
                          key: relPath,
                      },
                remove
                    ? {
                          type: 'del',
                          sublevel: fileMetaSublevel,
                          key: relPath,
                      }
                    : {
                          type: 'put',
                          sublevel: fileMetaSublevel,
                          key: relPath,
                          value: {
                              indexKeys: emitted.map(([k]) => k),
                              updatedAt: new Date(stats.mtimeMs).toISOString(),
                              // `failed` defeats the mtime skip-guard above,
                              // so quarantined documents stay retryable even
                              // though their updatedAt is current.
                              ...(failure ? { failed: true } : {}),
                          },
                          valueEncoding: 'json',
                      },
            ]);

            if (failure) {
                catalog.emit('problem', {
                    index: k,
                    path: relPath,
                    error: failure,
                });
            } else if (fileMeta.failed) {
                // Previously quarantined, now successfully indexed or
                // removed — either way it's no longer a problem.
                catalog.emit('resolved', { index: k, path: relPath });
            }
        }
    }

    const queue = new PQueue({ concurrency: 5 });

    // Infrastructure failures — watcher errors, unreadable files, LevelDB
    // trouble — surface as an 'error' event with standard EventEmitter
    // semantics: unhandled means it throws, because a silently stale index
    // is worse than a crash. Document-level process() failures are NOT
    // errors; they're quarantined and emitted as 'problem'. Every failure
    // has exactly one owner: reindex() rejections belong to the caller and
    // are never also emitted here. (p-queue re-emits task rejections as its
    // own 'error' events, but it uses eventemitter3, which is inert with no
    // listener — so those are safely ignored.)
    function emitError(e) {
        catalog.emit('error', e);
    }

    // The queue lets updates to different files run in parallel, but two
    // updates to the same file must not interleave their read-fileMeta /
    // write-batch cycles — both would read the same starting fileMeta and the
    // loser's emitted keys would be orphaned. Each file's updates therefore
    // chain behind the previous one. The chain links up synchronously when
    // the queue starts the task (start order is insertion order, so per-file
    // FIFO holds), and the wait happens inside the task so the queue's
    // pending count — which 'idle' watches — covers it.
    const fileTails = new Map();

    function queueFileUpdate(relPath, remove, stats) {
        return queue.add(() => {
            const tail = fileTails.get(relPath) ?? Promise.resolve();
            const run = tail.then(() => updatePath(relPath, remove, stats));

            const tracked = run
                .catch(() => {})
                .finally(() => {
                    if (fileTails.get(relPath) === tracked) {
                        fileTails.delete(relPath);
                    }
                });
            fileTails.set(relPath, tracked);

            return run;
        });
    }

    function queueRemove(path) {
        const relPath = toRelPath(path);
        if (!opts.shouldIndex(relPath)) return;
        debug('watcher: unlink', relPath);
        queueFileUpdate(relPath, true).catch(emitError);
    }

    function queueUpdate(path, stats) {
        const relPath = toRelPath(path);
        if (!opts.shouldIndex(relPath, stats)) return;
        debug('watcher: add/change', relPath);
        queueFileUpdate(relPath, false, stats).catch(emitError);
    }

    // chokidar won't reliably pick up files created in a directory that didn't
    // exist when the watch began, so ensure it's there first.
    fs.mkdirSync(opts.dataPath, { recursive: true });

    // On Windows, expand 8.3 short names (e.g. RUNNER~1) in the watch root:
    // libuv's fs-event watcher asserts — a native crash — when the watched
    // root's spelling differs from the long-form paths events report. This is
    // a one-time, root-only exception to the no-realpath rule (which is about
    // per-document identity); if even the root can't be resolved, keep the
    // lexical spelling and let the watcher try.
    /* c8 ignore start -- only reachable on win32; exercised by Windows CI */
    if (process.platform === 'win32') {
        try {
            opts.dataPath = fs.realpathSync.native(opts.dataPath);
        } catch {
            // Fall through with the lexical spelling.
        }
    }
    /* c8 ignore stop */

    // 'idle' means the whole catalog is quiescent, not just the queue — the
    // queue can momentarily drain while chokidar is still enumerating the
    // initial sweep, and that doesn't count.
    let sweepDone = false;

    // Passed through verbatim — the escape hatch for watcher tuning like
    // awaitWriteFinish. Deliberately not defaulted: awaitWriteFinish holds
    // initial-scan add events past chokidar's 'ready', which would make the
    // first 'idle' fire before pre-existing documents are indexed.
    const watcher = chokidar
        .watch(opts.dataPath, opts.chokidar)
        .on('add', queueUpdate)
        .on('change', queueUpdate)
        .on('unlink', queueRemove)
        .on('error', emitError)
        .on('ready', () => {
            sweepDone = true;
            if (queue.size === 0 && queue.pending === 0) {
                catalog.emit('idle');
            }
        });

    queue.on('idle', () => {
        if (sweepDone) {
            catalog.emit('idle');
        }
    });

    async function* scanIndex(levelDb, indexName, iterOpts) {
        const indexSublevel = await levelDb.sublevel('index', {
            keyEncoding: charwise,
            valueEncoding: indexes[indexName].valueEncoding ?? 'utf8',
        });

        for await (const [foundKey, levelVal] of indexSublevel.iterator(
            iterOpts,
        )) {
            const relPath = foundKey[foundKey.length - 1];
            const absPath = toAbsPath(relPath);
            yield {
                key:
                    foundKey.length === 2 ? foundKey[0] : foundKey.slice(0, -1),
                path: relPath,
                indexValue: levelVal,
                read(...args) {
                    return fs.promises.readFile(absPath, ...args);
                },
                readSync(...args) {
                    return fs.readFileSync(absPath, ...args);
                },
            };
        }
    }

    const indexApis = Object.fromEntries(
        Object.entries(indexDbs).map(([indexName, levelDb]) => [
            indexName,
            {
                async get(key) {
                    let result = null;

                    for await (const match of this.getMany(key)) {
                        if (result) {
                            throw new Error(
                                'Multiple matches for ' +
                                    JSON.stringify(key) +
                                    ' in index ' +
                                    JSON.stringify(indexName) +
                                    ': ' +
                                    result.path +
                                    ', ' +
                                    match.path,
                            );
                        }

                        result = match;
                    }

                    return result;
                },
                async *getMany(queryKey) {
                    assertNoUndefined(queryKey, 'query key');
                    queryKey = normalizeKey(queryKey);
                    yield* scanIndex(levelDb, indexName, {
                        gte: [...queryKey, KEY_BOTTOM],
                        lte: [...queryKey, KEY_TOP],
                    });
                },

                // Range scan over emitted keys. Bounds inherit getMany's
                // prefix semantics: each bound addresses a key's whole
                // subtree, so gte/lte include the bounding key's subtree
                // while gt/lt skip past it entirely. Omitted bounds are
                // open ends; getRange() with no bounds scans the whole
                // index. reverse walks the range high-to-low; limit caps
                // the number of entries yielded (per emitted entry, not
                // per distinct key), and applies after reversal.
                async *getRange(range = {}) {
                    const iterOpts = {};

                    // A top-level undefined bound just means "omitted";
                    // undefined nested inside an array bound is the
                    // sentinel hazard.
                    for (const bound of ['gt', 'gte', 'lt', 'lte']) {
                        if (range[bound] !== undefined) {
                            assertNoUndefined(range[bound], 'range bound');
                        }
                    }

                    if (range.gte !== undefined) {
                        iterOpts.gte = [...normalizeKey(range.gte), KEY_BOTTOM];
                    }
                    if (range.gt !== undefined) {
                        iterOpts.gt = [...normalizeKey(range.gt), KEY_TOP];
                    }
                    if (range.lte !== undefined) {
                        iterOpts.lte = [...normalizeKey(range.lte), KEY_TOP];
                    }
                    if (range.lt !== undefined) {
                        iterOpts.lt = [...normalizeKey(range.lt), KEY_BOTTOM];
                    }
                    if (range.reverse !== undefined) {
                        iterOpts.reverse = range.reverse;
                    }
                    if (range.limit !== undefined) {
                        iterOpts.limit = range.limit;
                    }

                    yield* scanIndex(levelDb, indexName, iterOpts);
                },

                // Documents quarantined because process() threw, as
                // recorded at the time of the failure.
                async *problems() {
                    const problemsSublevel = await levelDb.sublevel(
                        'problemDocuments',
                        { valueEncoding: 'json' },
                    );

                    for await (const [
                        path,
                        record,
                    ] of problemsSublevel.iterator()) {
                        yield { path, ...record };
                    }
                },
            },
        ]),
    );

    const catalog = Object.assign(new EventEmitter(), {
        indexes: indexApis,
        close: async () => {
            await watcher.close();
            await queue.onIdle();
            await Promise.all(Object.values(indexDbs).map((db) => db.close()));
        },
        dataPath: opts.dataPath,
        indexPath: opts.indexPath,

        // Index `path` now and resolve once done — for a writer that wants the
        // index to reflect its change synchronously instead of waiting for the
        // watcher. Goes through the same queue as watcher-driven updates (so no
        // race), and is idempotent with them. A missing file means "removed".
        // Takes a dataPath-relative or absolute path.
        async reindex(path) {
            const relPath = toRelPath(path);
            if (relPath.startsWith('..') || pathLib.isAbsolute(relPath)) {
                throw new Error('reindex path is outside dataPath: ' + path);
            }

            let stats;
            try {
                stats = await retryingEperm(() =>
                    fs.promises.stat(toAbsPath(relPath)),
                );
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return queueFileUpdate(relPath, true);
                }
                throw e;
            }
            return queueFileUpdate(relPath, false, stats);
        },
    });

    // Deprecated alias for `indexes`, kept for backward compatibility with
    // existing projects.
    Object.defineProperty(catalog, 'catalogs', {
        enumerable: false,
        get() {
            if (!warnedCatalogs) {
                warnedCatalogs = true;
                process.emitWarning(
                    'catalog.catalogs is deprecated; use catalog.indexes ' +
                        'instead.',
                    'DeprecationWarning',
                );
            }
            return indexApis;
        },
    });

    return catalog;
}

function buildKey(id, x) {
    return [...normalizeKey(x), id];
}

function normalizeKey(x) {
    return Array.isArray(x) ? x : [x];
}
