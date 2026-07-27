import cardcatalog from '../index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import pathLib from 'node:path';

import { once } from 'node:events';
import { test } from 'node:test';

const wordIndex = {
    valueEncoding: 'json',
    process: (content, emit) => {
        for (const word of content.toString('utf8').split(/\s+/g)) {
            if (word) {
                emit(word, true);
            }
        }
    },
};

// Silences the watcher without touching shouldIndex, so explicit reindex()
// calls are the only updates and can't be raced. (shouldIndex can't do this
// job any more — reindex respects it.)
const NO_WATCH = { chokidar: { ignored: () => true } };

// Watcher events arrive on the fs's schedule, not ours, so assertions on
// watcher-driven state have to poll.
async function eventually(fn, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await fn();
        } catch (e) {
            if (Date.now() > deadline) {
                throw e;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    }
}

function makeCatalog(t, indexes, opts = {}) {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const catalog = cardcatalog(indexes, {
        dataPath: pathLib.join(root, 'db'),
        indexPath: pathLib.join(root, 'index'),
        ...opts,
    });

    t.after(async () => {
        await catalog.close();
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    return catalog;
}

function writeDoc(catalog, name, content) {
    const path = pathLib.join(catalog.dataPath, name);
    fs.writeFileSync(path, content);
    return path;
}

async function collect(iter) {
    const result = [];
    for await (const x of iter) {
        result.push(x);
    }
    return result;
}

test('invalid configs throw at construction', async (t) => {
    assert.throws(() => cardcatalog(null), {
        name: 'TypeError',
        message: /indexes must be an object/,
    });
    assert.throws(() => cardcatalog('words'), {
        name: 'TypeError',
        message: /indexes must be an object/,
    });

    assert.throws(() => cardcatalog({ words: {} }), {
        name: 'TypeError',
        message: /index "words" needs a process function/,
    });
    assert.throws(() => cardcatalog({ words: { process: 5 } }), {
        name: 'TypeError',
        message: /index "words" needs a process function/,
    });
    assert.throws(() => cardcatalog({ words: null }), {
        name: 'TypeError',
        message: /index "words" needs a process function/,
    });

    // Index names become directory names under indexPath.
    for (const name of ['', '.', '..', '../evil', 'a/b', 'a\\b']) {
        assert.throws(
            () => cardcatalog({ [name]: { process: () => {} } }),
            { name: 'TypeError', message: /invalid index name/ },
            JSON.stringify(name),
        );
    }

    const words = { words: wordIndex };
    assert.throws(() => cardcatalog(words, { dataPath: 5 }), {
        message: /dataPath must be a string/,
    });
    assert.throws(() => cardcatalog(words, { indexPath: 5 }), {
        message: /indexPath must be a string/,
    });
    assert.throws(() => cardcatalog(words, { shouldIndex: null }), {
        message: /shouldIndex must be a function/,
    });
    assert.throws(() => cardcatalog(words, { chokidar: 'quiet' }), {
        message: /chokidar must be an object/,
    });
    assert.throws(() => cardcatalog(words, { inline: 'yes' }), {
        message: /inline must be a boolean/,
    });

    // Validation is side-effect-free: nothing was created on disk.
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    t.after(() =>
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        }),
    );
    assert.throws(() =>
        cardcatalog(
            { words: {} },
            {
                dataPath: pathLib.join(root, 'db'),
                indexPath: pathLib.join(root, 'index'),
            },
        ),
    );
    assert.deepEqual(fs.readdirSync(root), []);
});

test('both directories are created eagerly at construction', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const dataPath = pathLib.join(root, 'db');
    const indexPath = pathLib.join(root, 'deeply', 'nested', 'index');

    const catalog = cardcatalog({ words: wordIndex }, { dataPath, indexPath });
    t.after(async () => {
        await catalog.close();
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    // Before any query: classic-level opens lazily, so this only holds
    // because the directory is created up front.
    assert.ok(fs.existsSync(dataPath), 'dataPath');
    assert.ok(fs.existsSync(indexPath), 'indexPath, including missing parents');
});

test('a catalog with no indexes still creates indexPath', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const indexPath = pathLib.join(root, 'index');

    const catalog = cardcatalog(
        {},
        { dataPath: pathLib.join(root, 'db'), indexPath },
    );
    t.after(async () => {
        await catalog.close();
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    assert.ok(fs.existsSync(indexPath));
});

// Windows ignores mode bits here, and root bypasses them entirely.
const permissionsApply =
    process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

test(
    'an unwritable indexPath fails at construction, not mid-query',
    {
        skip: permissionsApply
            ? false
            : 'needs POSIX permissions and a non-root user',
    },
    async (t) => {
        const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
        const locked = pathLib.join(root, 'locked');
        fs.mkdirSync(locked, { mode: 0o500 });
        t.after(() => {
            fs.chmodSync(locked, 0o700);
            fs.rmSync(root, {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 50,
            });
        });

        assert.throws(
            () =>
                cardcatalog(
                    { words: wordIndex },
                    {
                        dataPath: pathLib.join(root, 'db'),
                        indexPath: pathLib.join(locked, 'index'),
                    },
                ),
            (e) => e.code === 'EACCES' && e.path.includes('index'),
        );
    },
);

test('watcher indexes pre-existing files', async (t) => {
    const rootDir = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const dataPath = pathLib.join(rootDir, 'db');
    fs.mkdirSync(dataPath);
    fs.writeFileSync(pathLib.join(dataPath, 'doc1'), 'alpha beta');

    const catalog = cardcatalog(
        { words: wordIndex },
        { dataPath, indexPath: pathLib.join(rootDir, 'index') },
    );
    t.after(async () => {
        await catalog.close();
        fs.rmSync(rootDir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    const match = await eventually(async () => {
        const m = await catalog.indexes.words.get('alpha');
        assert.ok(m, 'no match yet');
        return m;
    });

    assert.equal(match.key, 'alpha');
    assert.equal(match.path, 'doc1');
    assert.equal(match.indexValue, true);
    assert.equal((await match.read('utf8')).toString(), 'alpha beta');
    assert.equal(match.readSync('utf8'), 'alpha beta');
});

test('watcher removes entries for deleted files', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const path = writeDoc(catalog, 'doc1', 'upsilon');
    await eventually(async () => {
        assert.ok(await catalog.indexes.words.get('upsilon'), 'not indexed');
    });

    fs.unlinkSync(path);
    await eventually(async () => {
        assert.equal(await catalog.indexes.words.get('upsilon'), null);
    });
});

test('watcher picks up files created after startup', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    writeDoc(catalog, 'doc1', 'gamma delta');

    const match = await eventually(async () => {
        const m = await catalog.indexes.words.get('gamma');
        assert.ok(m, 'no match yet');
        return m;
    });

    assert.equal(match.path, 'doc1');
});

test('reindex() indexes a file without waiting for the watcher', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const path = writeDoc(catalog, 'doc1', 'epsilon');
    await catalog.reindex(path);

    const match = await catalog.indexes.words.get('epsilon');
    assert.equal(match.path, 'doc1');
});

test('reindex() of a missing file removes its entries', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const path = writeDoc(catalog, 'doc1', 'zeta');
    await catalog.reindex(path);
    assert.ok(await catalog.indexes.words.get('zeta'));

    fs.unlinkSync(path);
    await catalog.reindex(path);
    assert.equal(await catalog.indexes.words.get('zeta'), null);
});

test('re-processing a changed file replaces its old keys', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const path = writeDoc(catalog, 'doc1', 'eta');
    await catalog.reindex(path);

    // Ensure the rewrite bumps mtime past the stored one-second-resolution
    // ISO timestamp, or the update is skipped as already-indexed.
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path, 'theta');
    await catalog.reindex(path);

    assert.equal(await catalog.indexes.words.get('eta'), null);
    assert.ok(await catalog.indexes.words.get('theta'));
});

test('get() returns null on no match and throws on several', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'iota'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'iota'));

    assert.equal(await catalog.indexes.words.get('nope'), null);
    await assert.rejects(
        () => catalog.indexes.words.get('iota'),
        /Multiple matches for "iota" in index "words": doc1, doc2/,
    );
});

test('getMany() yields every matching document', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'kappa'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'kappa'));
    await catalog.reindex(writeDoc(catalog, 'doc3', 'lambda'));

    const matches = await collect(catalog.indexes.words.getMany('kappa'));
    assert.deepEqual(matches.map((m) => m.path).sort(), ['doc1', 'doc2']);
});

test('compound keys support prefix queries', async (t) => {
    const catalog = makeCatalog(t, {
        byTag: {
            process: (content, emit) => {
                for (const tag of content.toString('utf8').split(/\s+/g)) {
                    if (tag) {
                        emit(['tag', tag], tag);
                    }
                }
            },
        },
    });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'red'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'blue'));

    const exact = await collect(catalog.indexes.byTag.getMany(['tag', 'red']));
    assert.equal(exact.length, 1);
    assert.deepEqual(exact[0].key, ['tag', 'red']);
    assert.equal(exact[0].indexValue, 'red');

    const prefixed = await collect(catalog.indexes.byTag.getMany(['tag']));
    assert.deepEqual(prefixed.map((m) => m.indexValue).sort(), ['blue', 'red']);
});

test('undefined is rejected anywhere in a key', async (t) => {
    const catalog = makeCatalog(
        t,
        {
            words: {
                process: (content, emit) => emit(['a', undefined], 'x'),
            },
        },
        NO_WATCH,
    );

    // Emit-side: the offending document is quarantined with a clear message.
    const path = writeDoc(catalog, 'doc1', 'x');
    await catalog.reindex(path);
    const problems = await collect(catalog.indexes.words.problems());
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /reserved as the range-scan sentinel/);

    // Query-side: scalar, nested, and range-bound spellings all throw.
    await assert.rejects(
        collect(catalog.indexes.words.getMany(undefined)),
        /query key must not contain undefined/,
    );
    await assert.rejects(
        collect(catalog.indexes.words.getMany(['a', undefined])),
        /query key must not contain undefined/,
    );
    await assert.rejects(
        collect(catalog.indexes.words.getRange({ gte: ['a', undefined] })),
        /range bound must not contain undefined/,
    );

    // But a top-level undefined bound still just means "omitted".
    assert.deepEqual(
        await collect(catalog.indexes.words.getRange({ gte: undefined })),
        [],
    );
});

test('getRange() scans between bounds', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'apple'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'banana'));
    await catalog.reindex(writeDoc(catalog, 'doc3', 'cherry'));
    await catalog.reindex(writeDoc(catalog, 'doc4', 'date'));

    const words = catalog.indexes.words;
    const keys = async (range) =>
        (await collect(words.getRange(range))).map((m) => m.key);

    assert.deepEqual(await keys({ gte: 'banana', lte: 'cherry' }), [
        'banana',
        'cherry',
    ]);
    assert.deepEqual(await keys({ gt: 'banana', lt: 'date' }), ['cherry']);
    assert.deepEqual(await keys({ gte: 'cherry' }), ['cherry', 'date']);
    assert.deepEqual(await keys({ lt: 'banana' }), ['apple']);
    assert.deepEqual(await keys({}), ['apple', 'banana', 'cherry', 'date']);
});

test('getRange() supports reverse and limit', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'apple'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'banana'));
    await catalog.reindex(writeDoc(catalog, 'doc3', 'cherry'));
    await catalog.reindex(writeDoc(catalog, 'doc4', 'date'));

    const words = catalog.indexes.words;
    const keys = async (range) =>
        (await collect(words.getRange(range))).map((m) => m.key);

    assert.deepEqual(await keys({ reverse: true }), [
        'date',
        'cherry',
        'banana',
        'apple',
    ]);
    assert.deepEqual(await keys({ limit: 2 }), ['apple', 'banana']);
    assert.deepEqual(await keys({ reverse: true, limit: 2 }), [
        'date',
        'cherry',
    ]);
    assert.deepEqual(await keys({ gte: 'banana', reverse: true, limit: 2 }), [
        'date',
        'cherry',
    ]);
    assert.deepEqual(await keys({ lte: 'cherry', reverse: true, limit: 2 }), [
        'cherry',
        'banana',
    ]);
});

test('getRange() bounds address whole compound-key subtrees', async (t) => {
    const catalog = makeCatalog(t, {
        byTag: {
            process: (content, emit) => {
                for (const tag of content.toString('utf8').split(/\s+/g)) {
                    if (tag) {
                        emit(['tag', tag], tag);
                    }
                }
            },
        },
    });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'a'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'b'));
    await catalog.reindex(writeDoc(catalog, 'doc3', 'c'));

    const byTag = catalog.indexes.byTag;
    const values = async (range) =>
        (await collect(byTag.getRange(range))).map((m) => m.indexValue);

    // gt skips the whole ['tag', 'a'] subtree; lte includes all of
    // ['tag', 'c']'s.
    assert.deepEqual(await values({ gt: ['tag', 'a'], lte: ['tag', 'c'] }), [
        'b',
        'c',
    ]);

    // A bare ['tag'] bound addresses every tag at once.
    assert.deepEqual(await values({ gte: ['tag'] }), ['a', 'b', 'c']);
    assert.deepEqual(await values({ gt: ['tag'] }), []);
});

test('shouldIndex filters documents out', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { shouldIndex: (path) => !path.endsWith('.skip') },
    );

    const kept = writeDoc(catalog, 'doc1', 'mu');
    const skipped = writeDoc(catalog, 'doc2.skip', 'nu');

    await eventually(async () => {
        assert.ok(await catalog.indexes.words.get('mu'), 'no match yet');
    });
    assert.equal(await catalog.indexes.words.get('nu'), null);

    // Unlink events go through the same filter.
    fs.unlinkSync(skipped);
    fs.unlinkSync(kept);
    await eventually(async () => {
        assert.equal(await catalog.indexes.words.get('mu'), null);
    });
});

test('idle fires once the initial sweep is fully indexed', async (t) => {
    const rootDir = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const dataPath = pathLib.join(rootDir, 'db');
    fs.mkdirSync(dataPath);
    for (let i = 0; i < 20; i++) {
        fs.writeFileSync(pathLib.join(dataPath, 'doc' + i), 'omicron' + i);
    }

    const catalog = cardcatalog(
        { words: wordIndex },
        { dataPath, indexPath: pathLib.join(rootDir, 'index') },
    );
    t.after(async () => {
        await catalog.close();
        fs.rmSync(rootDir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    await once(catalog, 'idle');

    // No polling: idle promises every pre-existing document is queryable.
    for (let i = 0; i < 20; i++) {
        assert.ok(
            await catalog.indexes.words.get('omicron' + i),
            'doc' + i + ' not indexed at idle',
        );
    }
});

test('idle fires again after later changes are folded in', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });
    await once(catalog, 'idle');

    writeDoc(catalog, 'doc1', 'pi');
    await once(catalog, 'idle');

    assert.ok(await catalog.indexes.words.get('pi'));
});

test('subdirectory documents key with forward slashes everywhere', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    fs.mkdirSync(pathLib.join(catalog.dataPath, 'sub'), { recursive: true });
    const abs = pathLib.join(catalog.dataPath, 'sub', 'doc1');
    fs.writeFileSync(abs, 'nested');
    await catalog.reindex(abs);

    const match = await catalog.indexes.words.get('nested');
    assert.equal(match.path, 'sub/doc1');
    assert.equal((await match.read('utf8')).toString(), 'nested');

    // The forward-slash relative spelling reaches the same identity on
    // every platform.
    fs.unlinkSync(abs);
    await catalog.reindex('sub/doc1');
    assert.equal(await catalog.indexes.words.get('nested'), null);
});

test('reindex() honours shouldIndex and reports what it did', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        {
            ...NO_WATCH,
            shouldIndex: (path) => !path.endsWith('.skip'),
        },
    );

    // Filtered: left alone entirely, and says so.
    const skipped = writeDoc(catalog, 'doc1.skip', 'chi');
    assert.equal(await catalog.reindex(skipped), false);
    assert.equal(await catalog.indexes.words.get('chi'), null);

    // Not filtered: processed, and says so.
    const kept = writeDoc(catalog, 'doc2', 'psi');
    assert.equal(await catalog.reindex(kept), true);
    assert.ok(await catalog.indexes.words.get('psi'));

    // Removal consults shouldIndex too, so a filtered path stays a no-op
    // even when the file is gone.
    fs.unlinkSync(skipped);
    assert.equal(await catalog.reindex(skipped), false);

    fs.unlinkSync(kept);
    assert.equal(await catalog.reindex(kept), true);
    assert.equal(await catalog.indexes.words.get('psi'), null);
});

test('reindex() passes stats to shouldIndex when the file exists', async (t) => {
    const seen = [];
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        {
            ...NO_WATCH,
            shouldIndex: (path, stats) => {
                seen.push(stats);
                return true;
            },
        },
    );

    const path = writeDoc(catalog, 'doc1', 'omega');
    await catalog.reindex(path);
    assert.equal(typeof seen[0]?.mtimeMs, 'number');

    fs.unlinkSync(path);
    await catalog.reindex(path);
    assert.equal(seen[1], undefined);
});

test('an index survives moving the whole app directory', async (t) => {
    const base = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));

    // One hook, closing before removing: after hooks run in registration
    // order, and deleting a directory whose LevelDB is still open is EBUSY
    // on Windows.
    let second;
    t.after(async () => {
        if (second) {
            await second.close();
        }
        fs.rmSync(base, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    const before = pathLib.join(base, 'app-before');
    const after = pathLib.join(base, 'app-after');

    let processCalls = 0;
    const indexes = () => ({
        words: {
            valueEncoding: 'json',
            process: (content, emit) => {
                processCalls++;
                wordIndex.process(content, emit);
            },
        },
    });
    const at = (root) => ({
        dataPath: pathLib.join(root, 'db'),
        indexPath: pathLib.join(root, 'index'),
    });

    fs.mkdirSync(pathLib.join(before, 'db', 'sub'), { recursive: true });
    fs.writeFileSync(pathLib.join(before, 'db', 'doc1'), 'alpha');
    fs.writeFileSync(pathLib.join(before, 'db', 'sub', 'doc2'), 'beta');

    const first = cardcatalog(indexes(), at(before));
    await once(first, 'idle');
    await first.close();
    const callsBeforeMove = processCalls;
    assert.equal(callsBeforeMove, 2);

    // Pick up the whole app — db/ and index/ keep their relative positions.
    fs.renameSync(before, after);

    second = cardcatalog(indexes(), at(after));
    await once(second, 'idle');

    assert.equal((await second.indexes.words.get('alpha')).path, 'doc1');

    const beta = await second.indexes.words.get('beta');
    assert.equal(beta.path, 'sub/doc2');
    assert.equal((await beta.read('utf8')).toString(), 'beta');

    // Nothing was re-processed: the stored fileMeta keys still matched, which
    // is only true if paths were persisted relative to dataPath.
    assert.equal(processCalls, callsBeforeMove);
});

test('reindex() accepts dataPath-relative paths', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    writeDoc(catalog, 'doc1', 'rho');
    await catalog.reindex('doc1');

    assert.ok(await catalog.indexes.words.get('rho'));
});

test('reindex() rejects paths outside dataPath', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await assert.rejects(
        () => catalog.reindex('../escaped'),
        /outside dataPath/,
    );
    await assert.rejects(
        () => catalog.reindex('/etc/passwd'),
        /outside dataPath/,
    );
});

test('reindex() rethrows stat errors other than ENOENT', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, NO_WATCH);

    writeDoc(catalog, 'doc1', 'phi');

    // Monkeypatched rather than provoked via the fs: the natural trigger
    // (statting a path under a file) yields ENOTDIR on POSIX but ENOENT on
    // Windows.
    const realStat = fs.promises.stat;
    fs.promises.stat = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    t.after(() => {
        fs.promises.stat = realStat;
    });

    await assert.rejects(() => catalog.reindex('doc1'), { code: 'EACCES' });
    fs.promises.stat = realStat;
});

test('absolute and relative spellings are one identity', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const absPath = writeDoc(catalog, 'doc1', 'sigma');
    await catalog.reindex(absPath);

    fs.writeFileSync(absPath, 'tau');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(absPath, future, future);
    await catalog.reindex('doc1');

    // If the two spellings were keyed separately, 'sigma' would survive as
    // an orphan of the absolute-path identity.
    assert.equal(await catalog.indexes.words.get('sigma'), null);
    assert.ok(await catalog.indexes.words.get('tau'));
});

test('rapid updates to the same file do not interleave', async (t) => {
    const catalog = makeCatalog(t, {
        words: {
            valueEncoding: 'json',
            // Slow process() holds the first update's read-fileMeta/
            // write-batch cycle open long enough for the second to land
            // inside it if updates aren't serialized per file.
            process: async (content, emit) => {
                await new Promise((r) => setTimeout(r, 100));
                wordIndex.process(content, emit);
            },
        },
    });

    const path = writeDoc(catalog, 'doc1', 'one');
    const first = catalog.reindex(path);

    // Give the first update time to read the old content, then rewrite
    // with an explicitly bumped mtime — rapid writes can share a
    // millisecond, which the updatedAt guard would treat as unchanged.
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path, 'two');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path, future, future);
    const second = catalog.reindex(path);

    await Promise.all([first, second]);

    assert.equal(await catalog.indexes.words.get('one'), null);
    assert.ok(await catalog.indexes.words.get('two'));
});

test('a quarantined document is recorded and reported', async (t) => {
    const catalog = makeCatalog(t, {
        words: {
            ...wordIndex,
            process: (content, emit) => {
                if (content.toString('utf8').includes('boom')) {
                    throw new Error('kaboom');
                }
                wordIndex.process(content, emit);
            },
        },
    });

    await catalog.reindex(writeDoc(catalog, 'bad', 'boom'));

    const problems = await collect(catalog.indexes.words.problems());
    assert.equal(problems.length, 1);
    assert.equal(problems[0].path, 'bad');
    assert.equal(problems[0].message, 'kaboom');
    assert.ok(problems[0].stack);
    assert.ok(problems[0].at);
});

test('quarantine discards cards emitted before the throw', async (t) => {
    const catalog = makeCatalog(t, {
        words: {
            valueEncoding: 'json',
            process: (content, emit) => {
                emit('early', true);
                throw new Error('late kaboom');
            },
        },
    });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'x'));

    assert.equal(await catalog.indexes.words.get('early'), null);
});

test('a quarantined document retries without an mtime bump', async (t) => {
    let attempts = 0;
    const catalog = makeCatalog(
        t,
        {
            words: {
                valueEncoding: 'json',
                process: (content, emit) => {
                    if (++attempts === 1) {
                        throw new Error('transient');
                    }
                    emit('recovered', true);
                },
            },
        },
        // Keep the watcher out so reindex() calls are the only updates and
        // the attempt counter stays deterministic; reindex() bypasses
        // shouldIndex.
        NO_WATCH,
    );

    const path = writeDoc(catalog, 'doc1', 'x');
    await catalog.reindex(path);
    assert.equal(await catalog.indexes.words.get('recovered'), null);

    // Same file, same mtime: the failed flag must defeat the skip-guard.
    await catalog.reindex(path);
    assert.ok(await catalog.indexes.words.get('recovered'));
    assert.deepEqual(await collect(catalog.indexes.words.problems()), []);
});

test("'problem' and 'resolved' events track quarantine", async (t) => {
    let fail = true;
    const catalog = makeCatalog(
        t,
        {
            words: {
                valueEncoding: 'json',
                process: (content, emit) => {
                    if (fail) {
                        throw new Error('nope');
                    }
                    emit('fine', true);
                },
            },
        },
        NO_WATCH,
    );

    const problems = [];
    const resolveds = [];
    catalog.on('problem', (p) => problems.push(p));
    catalog.on('resolved', (r) => resolveds.push(r));

    const path = writeDoc(catalog, 'doc1', 'x');
    await catalog.reindex(path);

    assert.equal(problems.length, 1);
    assert.equal(problems[0].index, 'words');
    assert.equal(problems[0].path, 'doc1');
    assert.equal(problems[0].error.message, 'nope');
    assert.equal(resolveds.length, 0);

    fail = false;
    await catalog.reindex(path);

    assert.deepEqual(resolveds, [{ index: 'words', path: 'doc1' }]);
    assert.equal(problems.length, 1);
});

test('removing a quarantined document also resolves it', async (t) => {
    const catalog = makeCatalog(
        t,
        {
            words: {
                process: () => {
                    throw new Error('always');
                },
            },
        },
        NO_WATCH,
    );

    const resolveds = [];
    catalog.on('resolved', (r) => resolveds.push(r));

    const path = writeDoc(catalog, 'doc1', 'x');
    await catalog.reindex(path);
    assert.equal((await collect(catalog.indexes.words.problems())).length, 1);

    fs.unlinkSync(path);
    await catalog.reindex(path);

    assert.deepEqual(await collect(catalog.indexes.words.problems()), []);
    assert.deepEqual(resolveds, [{ index: 'words', path: 'doc1' }]);
});

test('chokidar options pass through to the watcher', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { chokidar: { ignored: (path) => path.endsWith('.tmp') } },
    );

    writeDoc(catalog, 'doc1', 'omega');
    writeDoc(catalog, 'doc2.tmp', 'hidden');

    await eventually(async () => {
        assert.ok(await catalog.indexes.words.get('omega'), 'no match yet');
    });
    assert.equal(await catalog.indexes.words.get('hidden'), null);
});

test('awaitWriteFinish can be enabled through the chokidar opt', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        {
            chokidar: {
                awaitWriteFinish: {
                    stabilityThreshold: 100,
                    pollInterval: 20,
                },
            },
        },
    );

    writeDoc(catalog, 'doc1', 'psi');

    // Can't wait on 'idle' here: with awaitWriteFinish, add events are held
    // past chokidar's ready, so the first idle may precede indexing.
    await eventually(async () => {
        assert.ok(await catalog.indexes.words.get('psi'), 'no match yet');
    });
});

test('EPERM during a Windows delete-pending resolves to removal', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, NO_WATCH);

    const path = writeDoc(catalog, 'doc1', 'win');
    await catalog.reindex(path);
    assert.ok(await catalog.indexes.words.get('win'));

    // Simulate Windows's delete-pending state: EPERM until the last handle
    // closes, then ENOENT.
    const realStat = fs.promises.stat;
    let calls = 0;
    fs.promises.stat = async () => {
        calls++;
        throw calls < 3
            ? Object.assign(new Error('pending'), { code: 'EPERM' })
            : Object.assign(new Error('gone'), { code: 'ENOENT' });
    };
    t.after(() => {
        fs.promises.stat = realStat;
    });

    await catalog.reindex(path);
    fs.promises.stat = realStat;
    assert.equal(await catalog.indexes.words.get('win'), null);
});

test('persistent EPERM is a real error', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, NO_WATCH);

    const path = writeDoc(catalog, 'doc1', 'locked');
    const realStat = fs.promises.stat;
    fs.promises.stat = async () => {
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
    };
    t.after(() => {
        fs.promises.stat = realStat;
    });

    await assert.rejects(() => catalog.reindex(path), { code: 'EPERM' });
    fs.promises.stat = realStat;
});

test('a file vanishing before its read is not an error', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, NO_WATCH);

    const errors = [];
    catalog.on('error', (e) => errors.push(e));

    const path = writeDoc(catalog, 'doc1', 'stray');
    const realReadFile = fs.promises.readFile;
    fs.promises.readFile = async () => {
        throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
    };
    t.after(() => {
        fs.promises.readFile = realReadFile;
    });

    // Resolves quietly: the unlink event is presumed to be on its way.
    await catalog.reindex(path);

    fs.promises.readFile = realReadFile;
    assert.equal(await catalog.indexes.words.get('stray'), null);
    assert.deepEqual(errors, []);
});

test("watcher-driven failures emit 'error'", async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const realReadFile = fs.promises.readFile;
    fs.promises.readFile = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    t.after(() => {
        fs.promises.readFile = realReadFile;
    });

    const errorFired = once(catalog, 'error');
    writeDoc(catalog, 'doc1', 'unreadable');

    const [error] = await errorFired;
    assert.equal(error.code, 'EACCES');
    fs.promises.readFile = realReadFile;
});

test("reindex() failures reject the caller, not 'error'", async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, NO_WATCH);

    const errors = [];
    catalog.on('error', (e) => errors.push(e));

    const path = writeDoc(catalog, 'doc1', 'mine');
    const realReadFile = fs.promises.readFile;
    fs.promises.readFile = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    t.after(() => {
        fs.promises.readFile = realReadFile;
    });

    await assert.rejects(() => catalog.reindex(path), { code: 'EACCES' });

    fs.promises.readFile = realReadFile;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(errors, []);
});

// Guards index.d.mts against drifting from what the implementation actually
// exposes; the type tests can only check the declarations' self-consistency.
test('runtime surface matches the type declarations', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, NO_WATCH);

    // Ignoring EventEmitter's own _-prefixed instance fields.
    assert.deepEqual(
        Object.keys(catalog)
            .filter((k) => !k.startsWith('_'))
            .sort(),
        ['close', 'dataPath', 'indexPath', 'indexes', 'reindex'],
    );
    assert.equal(typeof catalog.dataPath, 'string');
    assert.equal(typeof catalog.indexPath, 'string');
    assert.equal(typeof catalog.reindex, 'function');
    assert.equal(typeof catalog.close, 'function');
    assert.equal(typeof catalog.on, 'function');

    // Presence without access — the getter would fire its deprecation
    // warning, which another test counts.
    assert.ok(Object.getOwnPropertyDescriptor(catalog, 'catalogs')?.get);

    assert.deepEqual(Object.keys(catalog.indexes), ['words']);
    assert.deepEqual(Object.keys(catalog.indexes.words).sort(), [
        'get',
        'getMany',
        'getRange',
        'problems',
    ]);

    await catalog.reindex(writeDoc(catalog, 'doc1', 'surface'));

    const match = await catalog.indexes.words.get('surface');
    assert.deepEqual(Object.keys(match).sort(), [
        'indexValue',
        'key',
        'path',
        'read',
        'readSync',
    ]);
    assert.equal(typeof match.key, 'string');
    assert.equal(typeof match.path, 'string');
    assert.ok(Buffer.isBuffer(await match.read()));
    assert.equal(typeof (await match.read('utf8')), 'string');
    assert.ok(Buffer.isBuffer(match.readSync()));
    assert.equal(typeof match.readSync('utf8'), 'string');

    // reindex resolves to a boolean, as Promise<boolean> claims.
    assert.equal(await catalog.reindex('doc1'), true);
});

test('problem records match the declared Problem shape', async (t) => {
    const catalog = makeCatalog(
        t,
        {
            words: {
                process: () => {
                    throw new Error('shape');
                },
            },
        },
        NO_WATCH,
    );

    await catalog.reindex(writeDoc(catalog, 'doc1', 'x'));

    const [problem] = await collect(catalog.indexes.words.problems());
    assert.deepEqual(Object.keys(problem).sort(), [
        'at',
        'message',
        'path',
        'stack',
    ]);
    assert.equal(typeof problem.at, 'string');
    assert.equal(typeof problem.message, 'string');
    assert.equal(typeof problem.path, 'string');
    assert.equal(typeof problem.stack, 'string');
});

test("'problem' and 'resolved' payloads match their declared shapes", async (t) => {
    let fail = true;
    const catalog = makeCatalog(
        t,
        {
            words: {
                process: (content, emit) => {
                    if (fail) {
                        throw new Error('payload');
                    }
                    emit('ok', '');
                },
            },
        },
        NO_WATCH,
    );

    const problems = [];
    const resolveds = [];
    catalog.on('problem', (p) => problems.push(p));
    catalog.on('resolved', (r) => resolveds.push(r));

    const path = writeDoc(catalog, 'doc1', 'x');
    await catalog.reindex(path);
    fail = false;
    await catalog.reindex(path);

    assert.deepEqual(Object.keys(problems[0]).sort(), [
        'error',
        'index',
        'path',
    ]);
    assert.ok(problems[0].error instanceof Error);
    assert.deepEqual(Object.keys(resolveds[0]).sort(), ['index', 'path']);
});

test('catalogs is a deprecated alias for indexes', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const warnings = [];
    const onWarning = (w) => warnings.push(w);
    process.on('warning', onWarning);
    t.after(() => process.removeListener('warning', onWarning));

    assert.equal(catalog.catalogs, catalog.indexes);
    assert.equal(catalog.catalogs, catalog.indexes);

    // process.emitWarning delivers on a later tick.
    await new Promise((r) => setImmediate(r));
    const deprecations = warnings.filter((w) =>
        /catalog\.catalogs is deprecated/.test(w.message),
    );
    assert.equal(deprecations.length, 1, 'warns exactly once per process');
});

test('a throwing process() does not poison other documents', async (t) => {
    const catalog = makeCatalog(t, {
        words: {
            ...wordIndex,
            process: (content, emit) => {
                const text = content.toString('utf8');
                if (text.includes('boom')) {
                    throw new Error('boom');
                }
                wordIndex.process(content, emit);
            },
        },
    });

    await catalog.reindex(writeDoc(catalog, 'bad', 'boom'));
    await catalog.reindex(writeDoc(catalog, 'good', 'xi'));

    assert.equal(await catalog.indexes.words.get('boom'), null);
    assert.ok(await catalog.indexes.words.get('xi'));
});

// --- inline mode -----------------------------------------------------------

// Every assertion runs against both modes from one fixture, so a divergence
// between the stored index and the in-memory scan fails the suite.
for (const inline of [false, true]) {
    const mode = inline ? 'inline' : 'live';

    async function seedParity(t) {
        const catalog = makeCatalog(
            t,
            {
                byTag: {
                    valueEncoding: 'json',
                    process: (content, emit) => {
                        const doc = JSON.parse(content.toString('utf8'));
                        if (doc.broken) throw new Error('cannot process');
                        for (const tag of doc.tags ?? []) {
                            emit(['tag', tag], doc.title);
                        }
                        emit(doc.title, doc.title);
                    },
                },
            },
            { inline },
        );

        for (const [name, doc] of [
            ['a.json', { title: 'Alpha', tags: ['blue', 'red'] }],
            ['b.json', { title: 'Beta', tags: ['red'] }],
            ['sub/c.json', { title: 'Gamma', tags: ['zebra'] }],
        ]) {
            fs.mkdirSync(
                pathLib.dirname(pathLib.join(catalog.dataPath, name)),
                {
                    recursive: true,
                },
            );
            fs.writeFileSync(
                pathLib.join(catalog.dataPath, name),
                JSON.stringify(doc),
            );
            await catalog.reindex(name);
        }
        return catalog;
    }

    test(`${mode}: getRange walks bounds in charwise order`, async (t) => {
        const catalog = await seedParity(t);
        const keys = async (range) =>
            (await collect(catalog.indexes.byTag.getRange(range))).map(
                (m) => m.key,
            );

        assert.deepEqual(await keys({}), [
            'Alpha',
            'Beta',
            'Gamma',
            ['tag', 'blue'],
            ['tag', 'red'],
            ['tag', 'red'],
            ['tag', 'zebra'],
        ]);
        assert.deepEqual(await keys({ gte: ['tag'] }), [
            ['tag', 'blue'],
            ['tag', 'red'],
            ['tag', 'red'],
            ['tag', 'zebra'],
        ]);
        assert.deepEqual(await keys({ gt: ['tag'] }), []);
        assert.deepEqual(await keys({ lt: ['tag'] }), [
            'Alpha',
            'Beta',
            'Gamma',
        ]);
        assert.deepEqual(await keys({ reverse: true, limit: 2 }), [
            ['tag', 'zebra'],
            ['tag', 'red'],
        ]);
        assert.deepEqual(await keys({ limit: 2 }), ['Alpha', 'Beta']);
    });

    test(`${mode}: getMany matches prefixes, scalars, and nesting`, async (t) => {
        const catalog = await seedParity(t);
        const paths = async (key) =>
            (await collect(catalog.indexes.byTag.getMany(key)))
                .map((m) => m.path)
                .sort();

        assert.deepEqual(await paths(['tag', 'red']), ['a.json', 'b.json']);
        assert.deepEqual(await paths(['tag']), [
            'a.json',
            'a.json',
            'b.json',
            'sub/c.json',
        ]);
        assert.deepEqual(await paths('Alpha'), ['a.json']);
        assert.deepEqual(await paths(['Alpha']), ['a.json']);
        assert.deepEqual(await paths('absent'), []);
    });

    test(`${mode}: quarantined documents are reported, not indexed`, async (t) => {
        const catalog = await seedParity(t);
        fs.writeFileSync(
            pathLib.join(catalog.dataPath, 'bad.json'),
            JSON.stringify({ broken: true }),
        );
        await catalog.reindex('bad.json');

        const problems = await collect(catalog.indexes.byTag.problems());
        assert.deepEqual(
            problems.map((p) => p.path),
            ['bad.json'],
        );
        assert.equal(problems[0].message, 'cannot process');
        assert.equal(typeof problems[0].at, 'string');

        assert.deepEqual(
            (await collect(catalog.indexes.byTag.getRange({}))).filter(
                (m) => m.path === 'bad.json',
            ),
            [],
        );
    });

    test(`${mode}: undefined is rejected in keys and bounds`, async (t) => {
        const catalog = await seedParity(t);

        await assert.rejects(
            () => collect(catalog.indexes.byTag.getMany(['tag', undefined])),
            /reserved as the range-scan sentinel/,
        );
        await assert.rejects(
            () =>
                collect(
                    catalog.indexes.byTag.getRange({ gte: ['tag', undefined] }),
                ),
            /reserved as the range-scan sentinel/,
        );
    });

    test(`${mode}: shouldIndex filters the same way`, async (t) => {
        const catalog = makeCatalog(
            t,
            { words: wordIndex },
            { inline, shouldIndex: (path) => !path.endsWith('.skip') },
        );

        // Inline mode never writes, so it does not create dataPath either.
        fs.mkdirSync(catalog.dataPath, { recursive: true });
        fs.writeFileSync(pathLib.join(catalog.dataPath, 'keep.json'), 'kept');
        fs.writeFileSync(pathLib.join(catalog.dataPath, 'drop.skip'), 'gone');
        await catalog.reindex('keep.json');

        assert.ok(await catalog.indexes.words.get('kept'));
        assert.equal(await catalog.indexes.words.get('gone'), null);
        assert.equal(await catalog.reindex('drop.skip'), false);
    });

    test(`${mode}: idle fires as a ready signal`, async (t) => {
        const catalog = makeCatalog(t, { words: wordIndex }, { inline });
        await once(catalog, 'idle');
        assert.ok(true);
    });
}

test('inline: read, readSync, lte/lt bounds, and duplicate-key collapse', async (t) => {
    const catalog = makeCatalog(
        t,
        {
            words: {
                valueEncoding: 'json',
                process: (content, emit) => {
                    emit('dup', 'first');
                    emit('dup', 'second'); // same stored key; last wins
                    emit('other', 'x');
                },
            },
        },
        { inline: true },
    );

    fs.mkdirSync(catalog.dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'doc.json'), 'body');

    const dup = await catalog.indexes.words.get('dup');
    assert.equal(dup.indexValue, 'second');
    assert.equal((await dup.read('utf8')).toString(), 'body');
    assert.equal(dup.readSync('utf8'), 'body');

    const keys = async (range) =>
        (await collect(catalog.indexes.words.getRange(range))).map(
            (m) => m.key,
        );
    assert.deepEqual(await keys({ lte: 'dup' }), ['dup']);
    assert.deepEqual(await keys({ lt: 'other' }), ['dup']);
});

test('inline: get names the colliding documents', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: { process: (content, emit) => emit('shared', '') } },
        { inline: true },
    );

    fs.mkdirSync(catalog.dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'a.json'), '1');
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'b.json'), '2');

    await assert.rejects(
        () => catalog.indexes.words.get('shared'),
        /Multiple matches for "shared" in index "words": a\.json, b\.json/,
    );
});

test('inline: reindex validates paths and reports filtering', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { inline: true, shouldIndex: (path) => !path.endsWith('.skip') },
    );

    fs.mkdirSync(catalog.dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'doc.json'), 'x');

    assert.equal(await catalog.reindex('doc.json'), true);
    assert.equal(await catalog.reindex('gone.json'), true); // absent, unfiltered
    assert.equal(await catalog.reindex('gone.skip'), false); // absent, filtered

    await assert.rejects(
        () => catalog.reindex('../escaped'),
        /outside dataPath/,
    );
});

test('inline: tolerates a missing collection and surfaces real failures', async (t) => {
    const missing = makeCatalog(t, { words: wordIndex }, { inline: true });

    // Never created, so the walk finds nothing rather than failing.
    assert.equal(fs.existsSync(missing.dataPath), false);
    assert.deepEqual(await collect(missing.indexes.words.getRange({})), []);
    assert.deepEqual(await collect(missing.indexes.words.problems()), []);

    // A dataPath that is a file, not a directory, is a real error.
    const broken = makeCatalog(t, { words: wordIndex }, { inline: true });
    fs.mkdirSync(pathLib.dirname(broken.dataPath), { recursive: true });
    fs.writeFileSync(broken.dataPath, 'not a directory');
    await assert.rejects(() => collect(broken.indexes.words.getRange({})), {
        code: 'ENOTDIR',
    });
});

test('inline: skips entries that are not documents', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, { inline: true });
    fs.mkdirSync(catalog.dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'real'), 'kept');
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'ghost'), 'gone');
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'weird'), 'odd');

    const realStat = fs.promises.stat;
    fs.promises.stat = async (p, ...rest) => {
        // Vanished between readdir and stat.
        if (String(p).endsWith('ghost')) {
            throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        // Something that is not a regular file, e.g. a symlinked directory.
        if (String(p).endsWith('weird')) {
            return { ...(await realStat(p, ...rest)), isFile: () => false };
        }
        return realStat(p, ...rest);
    };
    t.after(() => {
        fs.promises.stat = realStat;
    });

    const paths = (await collect(catalog.indexes.words.getRange({}))).map(
        (m) => m.path,
    );
    fs.promises.stat = realStat;
    assert.deepEqual(paths, ['real']);
});

test('inline: a document vanishing before its read is skipped', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, { inline: true });
    fs.mkdirSync(catalog.dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'keep'), 'kept');
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'racy'), 'gone');

    const realRead = fs.promises.readFile;
    fs.promises.readFile = async (p, ...rest) => {
        if (String(p).endsWith('racy')) {
            throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return realRead(p, ...rest);
    };
    t.after(() => {
        fs.promises.readFile = realRead;
    });

    assert.deepEqual(
        (await collect(catalog.indexes.words.getRange({}))).map((m) => m.path),
        ['keep'],
    );

    // A read failure that is not a race still propagates.
    fs.promises.readFile = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    await assert.rejects(() => collect(catalog.indexes.words.getRange({})), {
        code: 'EACCES',
    });
    fs.promises.readFile = realRead;
});

test('inline: a stat failure during the walk propagates', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, { inline: true });
    fs.mkdirSync(catalog.dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(catalog.dataPath, 'doc'), 'body');

    const realStat = fs.promises.stat;
    fs.promises.stat = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    t.after(() => {
        fs.promises.stat = realStat;
    });

    await assert.rejects(() => collect(catalog.indexes.words.getRange({})), {
        code: 'EACCES',
    });
    fs.promises.stat = realStat;
});

test('inline: reindex rethrows stat failures other than ENOENT', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex }, { inline: true });

    const realStat = fs.promises.stat;
    fs.promises.stat = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    t.after(() => {
        fs.promises.stat = realStat;
    });

    await assert.rejects(() => catalog.reindex('doc.json'), { code: 'EACCES' });
    fs.promises.stat = realStat;
});

test('inline mode keeps no index and holds no lock', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const dataPath = pathLib.join(root, 'db');
    const indexPath = pathLib.join(root, 'index');
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(pathLib.join(dataPath, 'doc.json'), 'shared');

    // A live catalog holds an exclusive lock on its index; an inline one over
    // the same documents must not contend with it.
    const live = cardcatalog({ words: wordIndex }, { dataPath, indexPath });
    const inline = cardcatalog(
        { words: wordIndex },
        { dataPath, indexPath, inline: true },
    );
    t.after(async () => {
        await live.close();
        await inline.close();
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    await once(live, 'idle');
    assert.ok(await inline.indexes.words.get('shared'));

    // No index directory is created for it, and it reports none.
    assert.equal(inline.indexPath, undefined);
});
