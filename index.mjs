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

    const indexDbs = Object.fromEntries(
        Object.entries(indexes).map(([k]) => [
            k,
            new ClassicLevel(pathLib.join(opts.indexPath, k)),
        ]),
    );

    async function updatePath(path, remove, stats) {
        const fileContent = remove
            ? undefined
            : await fs.promises.readFile(path);

        for (const k of Object.keys(indexes)) {
            const indexConfig = indexes[k];

            const fileMeta =
                (await indexDbs[k]
                    .sublevel('fileMeta')
                    .get(path, { valueEncoding: 'json' })) ?? {};

            if (
                !remove &&
                fileMeta.updatedAt &&
                fileMeta.updatedAt >= new Date(stats.mtimeMs).toISOString()
            ) {
                debug('For index ' + k + ' skipping ' + path + '.');
                continue;
            }

            const emitted = [];

            if (!remove) {
                try {
                    await indexes[k].process(
                        fileContent,
                        (k, v) => emitted.push([buildKey(path, k), v]),
                        { path },
                    );
                } catch (e) {
                    await indexDbs[k].sublevel('problemDocuments').put(
                        path,
                        {
                            at: new Date().toISOString(),
                            message: e.message,
                            stack: e.stack,
                        },
                        { valueEncoding: 'json' },
                    );
                }
            }

            debug('\nFor index ' + k + ' updating ' + path + '.');
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
                    value: path,
                    keyEncoding: charwise,
                    valueEncoding: 'utf8',
                })),
                {
                    type: 'del',
                    sublevel: problemDocumentsSublevel,
                    key: path,
                },
                remove
                    ? {
                          type: 'del',
                          sublevel: fileMetaSublevel,
                          key: path,
                      }
                    : {
                          type: 'put',
                          sublevel: fileMetaSublevel,
                          key: path,
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

    function queueRemove(path) {
        if (!opts.shouldIndex(path)) return;
        debug('watcher: unlink', path);
        queue
            .add(() => updatePath(path, true))
            .catch((e) =>
                console.error('cardcatalog remove failed for ' + path + ':', e),
            );
    }

    function queueUpdate(path, stats) {
        if (!opts.shouldIndex(path, stats)) return;
        debug('watcher: add/change', path);
        queue
            .add(() => updatePath(path, false, stats))
            .catch((e) =>
                console.error('cardcatalog update failed for ' + path + ':', e),
            );
    }

    // chokidar won't reliably pick up files created in a directory that didn't
    // exist when the watch began, so ensure it's there first.
    fs.mkdirSync(opts.dataPath, { recursive: true });

    const watcher = chokidar
        .watch(opts.dataPath)
        .on('add', queueUpdate)
        .on('change', queueUpdate)
        .on('unlink', queueRemove);

    return {
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
                            const path = foundKey[foundKey.length - 1];
                            yield {
                                key:
                                    foundKey.length === 2
                                        ? foundKey[0]
                                        : foundKey.slice(0, -1),
                                path: pathLib.relative(opts.dataPath, path),
                                indexValue: levelVal,
                                read(...args) {
                                    return fs.promises.readFile(path, ...args);
                                },
                                readSync(...args) {
                                    return fs.readFileSync(path, ...args);
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
        async reindex(path) {
            let stats;
            try {
                stats = await fs.promises.stat(path);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return queue.add(() => updatePath(path, true));
                }
                throw e;
            }
            return queue.add(() => updatePath(path, false, stats));
        },
    };
}

function buildKey(id, x) {
    if (!Array.isArray(x)) {
        x = [x];
    }

    return [...x, id];
}
