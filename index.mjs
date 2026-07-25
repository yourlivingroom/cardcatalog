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

export default function cardcatalog(indexes, opts = {}) {
    opts = shallowMerge(
        {
            dataPath: './db',
            indexPath: './index',
            shouldIndex: () => true,
        },
        opts,
    );

    // Documents are identified everywhere — index keys, fileMeta, the public
    // API — by their dataPath-relative path, computed lexically. Physical
    // canonicalization (realpath) is deliberately avoided: it needs search
    // permission on every ancestor directory and fails outright on deleted
    // files, which is exactly the remove case.
    opts.dataPath = pathLib.resolve(opts.dataPath);

    // Relative inputs are taken as dataPath-relative already; absolute ones
    // are made relative. Both lexically.
    function toRelPath(path) {
        return pathLib.relative(
            opts.dataPath,
            pathLib.resolve(opts.dataPath, path),
        );
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
        const fileContent = remove
            ? undefined
            : await fs.promises.readFile(toAbsPath(relPath));

        for (const k of Object.keys(indexes)) {
            const indexConfig = indexes[k];

            const fileMeta =
                (await indexDbs[k]
                    .sublevel('fileMeta')
                    .get(relPath, { valueEncoding: 'json' })) ?? {};

            if (
                !remove &&
                fileMeta.updatedAt &&
                fileMeta.updatedAt >= new Date(stats.mtimeMs).toISOString()
            ) {
                debug('For index ' + k + ' skipping ' + relPath + '.');
                continue;
            }

            const emitted = [];

            if (!remove) {
                try {
                    await indexes[k].process(
                        fileContent,
                        (k, v) => emitted.push([buildKey(relPath, k), v]),
                        { path: relPath },
                    );
                } catch (e) {
                    await indexDbs[k].sublevel('problemDocuments').put(
                        relPath,
                        {
                            at: new Date().toISOString(),
                            message: e.message,
                            stack: e.stack,
                        },
                        { valueEncoding: 'json' },
                    );
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
                {
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
                          },
                          valueEncoding: 'json',
                      },
            ]);
        }
    }

    const queue = new PQueue({ concurrency: 5 });
    queue.on('error', (e) => console.error('cardcatalog index error:', e));

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
        queueFileUpdate(relPath, true).catch((e) =>
            console.error('cardcatalog remove failed for ' + relPath + ':', e),
        );
    }

    function queueUpdate(path, stats) {
        const relPath = toRelPath(path);
        if (!opts.shouldIndex(relPath, stats)) return;
        debug('watcher: add/change', relPath);
        queueFileUpdate(relPath, false, stats).catch((e) =>
            console.error('cardcatalog update failed for ' + relPath + ':', e),
        );
    }

    // chokidar won't reliably pick up files created in a directory that didn't
    // exist when the watch began, so ensure it's there first.
    fs.mkdirSync(opts.dataPath, { recursive: true });

    // 'idle' means the whole catalog is quiescent, not just the queue — the
    // queue can momentarily drain while chokidar is still enumerating the
    // initial sweep, and that doesn't count.
    let sweepDone = false;

    const watcher = chokidar
        .watch(opts.dataPath)
        .on('add', queueUpdate)
        .on('change', queueUpdate)
        .on('unlink', queueRemove)
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

    const catalog = Object.assign(new EventEmitter(), {
        catalogs: Object.fromEntries(
            Object.entries(indexDbs).map(([indexName, levelDb]) => [
                indexName,
                {
                    async get(key) {
                        let result = null;

                        for await (const match of this.getMany(key)) {
                            if (result) {
                                throw new Error('Multiple matches');
                            }

                            result = match;
                        }

                        return result;
                    },
                    async *getMany(queryKey) {
                        if (!Array.isArray(queryKey)) {
                            queryKey = [queryKey];
                        }

                        const indexSublevel = await levelDb.sublevel('index', {
                            keyEncoding: charwise,
                            valueEncoding:
                                indexes[indexName].valueEncoding ?? 'utf8',
                        });

                        const levelIter = indexSublevel.iterator({
                            gte: [...queryKey, KEY_BOTTOM],
                            lte: [...queryKey, KEY_TOP],
                        });

                        for await (const [foundKey, levelVal] of levelIter) {
                            const relPath = foundKey[foundKey.length - 1];
                            const absPath = toAbsPath(relPath);
                            yield {
                                key:
                                    foundKey.length === 2
                                        ? foundKey[0]
                                        : foundKey.slice(0, -1),
                                path: relPath,
                                indexValue: levelVal,
                                read(...args) {
                                    return fs.promises.readFile(
                                        absPath,
                                        ...args,
                                    );
                                },
                                readSync(...args) {
                                    return fs.readFileSync(absPath, ...args);
                                },
                            };
                        }
                    },
                },
            ]),
        ),
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
                stats = await fs.promises.stat(toAbsPath(relPath));
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return queueFileUpdate(relPath, true);
                }
                throw e;
            }
            return queueFileUpdate(relPath, false, stats);
        },
    });

    return catalog;
}

function buildKey(id, x) {
    if (!Array.isArray(x)) {
        x = [x];
    }

    return [...x, id];
}
