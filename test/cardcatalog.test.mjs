import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import pathLib from 'node:path';
import { test } from 'node:test';

import cardcatalog from '../index.mjs';

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
        fs.rmSync(root, { recursive: true, force: true });
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

    // Validation is side-effect-free: nothing was created on disk.
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
        fs.rmSync(rootDir, { recursive: true, force: true });
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
        fs.rmSync(rootDir, { recursive: true, force: true });
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
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { shouldIndex: () => false },
    );

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
        { shouldIndex: () => false },
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
        { shouldIndex: () => false },
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
        { shouldIndex: () => false },
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

test('a file vanishing before its read is not an error', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { shouldIndex: () => false },
    );

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
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { shouldIndex: () => false },
    );

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
