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
        const m = await catalog.catalogs.words.get('alpha');
        assert.ok(m, 'no match yet');
        return m;
    });

    assert.equal(match.key, 'alpha');
    assert.equal(match.path, 'doc1');
    assert.equal(match.indexValue, true);
    assert.equal((await match.read('utf8')).toString(), 'alpha beta');
});

test('watcher picks up files created after startup', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    writeDoc(catalog, 'doc1', 'gamma delta');

    const match = await eventually(async () => {
        const m = await catalog.catalogs.words.get('gamma');
        assert.ok(m, 'no match yet');
        return m;
    });

    assert.equal(match.path, 'doc1');
});

test('reindex() indexes a file without waiting for the watcher', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const path = writeDoc(catalog, 'doc1', 'epsilon');
    await catalog.reindex(path);

    const match = await catalog.catalogs.words.get('epsilon');
    assert.equal(match.path, 'doc1');
});

test('reindex() of a missing file removes its entries', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    const path = writeDoc(catalog, 'doc1', 'zeta');
    await catalog.reindex(path);
    assert.ok(await catalog.catalogs.words.get('zeta'));

    fs.unlinkSync(path);
    await catalog.reindex(path);
    assert.equal(await catalog.catalogs.words.get('zeta'), null);
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

    assert.equal(await catalog.catalogs.words.get('eta'), null);
    assert.ok(await catalog.catalogs.words.get('theta'));
});

test('get() returns null on no match and throws on several', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'iota'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'iota'));

    assert.equal(await catalog.catalogs.words.get('nope'), null);
    await assert.rejects(
        () => catalog.catalogs.words.get('iota'),
        /Multiple matches/,
    );
});

test('getMany() yields every matching document', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });

    await catalog.reindex(writeDoc(catalog, 'doc1', 'kappa'));
    await catalog.reindex(writeDoc(catalog, 'doc2', 'kappa'));
    await catalog.reindex(writeDoc(catalog, 'doc3', 'lambda'));

    const matches = await collect(catalog.catalogs.words.getMany('kappa'));
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

    const exact = await collect(catalog.catalogs.byTag.getMany(['tag', 'red']));
    assert.equal(exact.length, 1);
    assert.deepEqual(exact[0].key, ['tag', 'red']);
    assert.equal(exact[0].indexValue, 'red');

    const prefixed = await collect(catalog.catalogs.byTag.getMany(['tag']));
    assert.deepEqual(prefixed.map((m) => m.indexValue).sort(), ['blue', 'red']);
});

test('shouldIndex filters documents out', async (t) => {
    const catalog = makeCatalog(
        t,
        { words: wordIndex },
        { shouldIndex: (path) => !path.endsWith('.skip') },
    );

    writeDoc(catalog, 'doc1', 'mu');
    writeDoc(catalog, 'doc2.skip', 'nu');

    await eventually(async () => {
        assert.ok(await catalog.catalogs.words.get('mu'), 'no match yet');
    });
    assert.equal(await catalog.catalogs.words.get('nu'), null);
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
            await catalog.catalogs.words.get('omicron' + i),
            'doc' + i + ' not indexed at idle',
        );
    }
});

test('idle fires again after later changes are folded in', async (t) => {
    const catalog = makeCatalog(t, { words: wordIndex });
    await once(catalog, 'idle');

    writeDoc(catalog, 'doc1', 'pi');
    await once(catalog, 'idle');

    assert.ok(await catalog.catalogs.words.get('pi'));
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

    assert.equal(await catalog.catalogs.words.get('one'), null);
    assert.ok(await catalog.catalogs.words.get('two'));
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

    assert.equal(await catalog.catalogs.words.get('boom'), null);
    assert.ok(await catalog.catalogs.words.get('xi'));
});
