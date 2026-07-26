# cardcatalog

[![CI](https://github.com/yourlivingroom/cardcatalog/actions/workflows/ci.yml/badge.svg)](https://github.com/yourlivingroom/cardcatalog/actions/workflows/ci.yml)
[![Coverage](https://raw.githubusercontent.com/yourlivingroom/cardcatalog/badges/coverage.svg)](https://github.com/yourlivingroom/cardcatalog/actions/workflows/ci.yml)

Persistent, incrementally-maintained indexes over a directory of files.

You tell cardcatalog what cards to write for each document; it keeps the
drawers sorted as documents come and go. Under the hood: [chokidar] watches the
directory, your `process` function maps each file to index entries (in the
style of a CouchDB map view), and each index is persisted in its own
[LevelDB][classic-level] so lookups are fast and survive restarts.

[chokidar]: https://github.com/paulmillr/chokidar
[classic-level]: https://github.com/Level/classic-level

## Quick start

```js
import { once } from 'events';
import cardcatalog from '@livingroom/cardcatalog';

const catalog = cardcatalog(
    {
        byAuthor: {
            valueEncoding: 'json',
            process: (content, emit) => {
                const doc = JSON.parse(content.toString('utf8'));
                for (const author of doc.authors ?? []) {
                    emit(author, doc.title);
                }
            },
        },
    },
    { dataPath: './books' },
);

// The first 'idle' means every pre-existing document has been indexed.
await once(catalog, 'idle');

for await (const match of catalog.catalogs.byAuthor.getMany('Le Guin')) {
    console.log(match.path, '→', match.indexValue);
}
```

Drop a new file into `./books` and it's indexed automatically; delete one and
its entries disappear.

## How it works

For every file in `dataPath`, each index's `process(content, emit, { path })`
is called with the file's content as a raw `Buffer`. Every `emit(key, value)`
writes one card: the emitted key (a string, number, or array of them) plus the
document's path become a sorted LevelDB key, so looking up a key — or a key
prefix, or a range — is a contiguous scan.

Documents are identified by their `dataPath`-relative path. Updates are atomic
per file per index: a document's old cards are removed in the same batch that
writes its new ones. Unchanged files (by mtime) are skipped on restart, so
re-opening a catalog over a large directory is cheap.

If `process` throws, that document is quarantined — atomically: cards emitted
before the throw are discarded, the document's old cards are removed, and the
error is recorded, all in one batch. A quarantined document contributes
nothing to the index until it's retried, which happens when the file changes,
when `reindex()` is called, or on the next startup sweep; the record clears
automatically on success. Quarantined documents are visible through
`problems()` and the `'problem'`/`'resolved'` events. One bad document never
poisons the rest of the catalog.

## API

### `cardcatalog(indexes, opts?) → catalog`

`indexes` is a map of index name → config:

- `process(content, emit, { path })` — required, may be async. `content` is a
  `Buffer` (see [Decoding is your job](#decoding-is-your-job)); call
  `emit(key, value)` any number of times. `path` is the document's
  `dataPath`-relative path.
- `valueEncoding` — Level encoding for emitted values (default `'utf8'`;
  `'json'` is handy).

`opts`:

- `dataPath` — directory of documents to watch (default `'./db'`, created if
  missing).
- `indexPath` — where the index databases live (default `'./index'`).
- `shouldIndex(relPath, stats?)` — return false to skip a document.

### The catalog

- `catalog.catalogs.<name>.get(key)` — the single match for `key`, or `null`.
  Throws if there are several (the error names the key, index, and colliding
  paths) — calling `get` asserts the key is unique.
- `catalog.catalogs.<name>.getMany(key)` — async generator over every match
  for `key`, including compound keys it prefixes: with `emit(['tag', t], …)`,
  `getMany(['tag'])` yields every tag entry.
- `catalog.catalogs.<name>.getRange({ gt, gte, lt, lte, reverse, limit })` —
  async generator over a key range. Bounds have the same subtree semantics as
  `getMany`: `gte`/`lte` include the bounding key's whole subtree, `gt`/`lt`
  skip past it. Omitted bounds are open ends; `getRange({})` scans the whole
  index. `reverse` walks high-to-low; `limit` caps yielded entries and applies
  after reversal, so `{ reverse: true, limit: n }` is "last n".
- `catalog.catalogs.<name>.problems()` — async generator over this index's
  quarantined documents: `{ path, at, message, stack }`, as recorded when
  `process` threw.
- `catalog.reindex(path)` — index (or, if deleted, de-index) a document right
  now instead of waiting for the watcher; resolves when done. Takes a
  `dataPath`-relative or absolute path. Use it when your own code writes a
  document and wants read-your-writes.
- `catalog.close()` — stop watching, drain pending work, close the databases.
- Event `'idle'` — emitted whenever the catalog goes fully quiescent: the
  initial sweep has been enumerated _and_ every queued update has been
  applied. The first `'idle'` doubles as a ready signal; later ones mean
  "caught up again".
- Event `'problem'` — `{ index, path, error }`, emitted each time a document
  is quarantined (including repeat failures on retry).
- Event `'resolved'` — `{ index, path }`, emitted when a previously
  quarantined document is successfully reindexed or removed. Between these
  two events you never need to poll `problems()`.

Matches yielded by `get`/`getMany`/`getRange` look like:

```js
{
    key,        // the emitted key
    path,       // document path, relative to dataPath
    indexValue, // the emitted value
    read,       // (...args) => fs.promises.readFile(<document>, ...args)
    readSync,   // (...args) => fs.readFileSync(<document>, ...args)
}
```

## Decoding is your job

`process` receives a raw `Buffer` on purpose. If cardcatalog decoded for you,
it would have to pick a strictness policy — and `buffer.toString('utf8')`
never fails: when a binary file sneaks into what you thought was a directory
of text files, invalid bytes are silently replaced with `U+FFFD` and the
garbage goes straight into your index.

If that hazard applies to your data, decode strictly — one line buys you
loud, quarantined failures instead of mojibake:

```js
const utf8 = new TextDecoder('utf-8', { fatal: true });

const catalog = cardcatalog({
    words: {
        process: (content, emit) => {
            // Throws on invalid UTF-8, so a stray binary file is quarantined
            // in problemDocuments instead of being indexed as garbage.
            const text = utf8.decode(content);

            for (const word of text.split(/\s+/g)) {
                if (word) {
                    emit(word, '');
                }
            }
        },
    },
});
```

If lenient decoding is what you want, `content.toString('utf8')` is right
there — the point is that you choose.

## License

[ISC](./LICENSE)
