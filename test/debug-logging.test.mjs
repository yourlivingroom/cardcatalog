import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import pathLib from 'node:path';
import { test } from 'node:test';

// The debug logger is chosen at module load, so the env var must be set (and
// console.log stubbed — debug binds it) before index.mjs is imported. That's
// why this lives in its own test file: node:test gives it a fresh process.
process.env.CARDCATALOG_DEBUG = '1';

const logs = [];
console.log = (...args) => logs.push(args);

const { default: cardcatalog } = await import('../index.mjs');

test('CARDCATALOG_DEBUG turns on debug logging', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'cardcatalog-'));
    const catalog = cardcatalog(
        { words: { process: (content, emit) => emit('chi', '') } },
        {
            dataPath: pathLib.join(root, 'db'),
            indexPath: pathLib.join(root, 'index'),
        },
    );
    t.after(async () => {
        await catalog.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const path = pathLib.join(catalog.dataPath, 'doc1');
    fs.writeFileSync(path, 'anything');
    await catalog.reindex(path);
    fs.unlinkSync(path);
    await catalog.reindex(path);

    const flat = logs.flat().map(String).join('\n');
    assert.match(flat, /updating doc1/);
});
