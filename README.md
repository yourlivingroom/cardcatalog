# cardcatalog

[![CI](https://github.com/yourlivingroom/cardcatalog/actions/workflows/ci.yml/badge.svg)](https://github.com/yourlivingroom/cardcatalog/actions/workflows/ci.yml)
[![Coverage](https://raw.githubusercontent.com/yourlivingroom/cardcatalog/badges/coverage.svg)](https://github.com/yourlivingroom/cardcatalog/actions/workflows/ci.yml)

Persistent, incrementally-maintained LevelDB indexes over a watched directory.

Point `cardcatalog` at a directory and provide one or more indexing functions,
and it will watch contained files for changes and update indexes as needed.

Under the hood: [chokidar] watches the directory and runs your `process`
functions on each file as it appears or changes. Process functions emit index
entries into a [LevelDB][classic-level] and existing index entries are replaced
when a file updates. Indexes are thus similar to [CouchDB][couchdb].

[chokidar]: https://github.com/paulmillr/chokidar
[classic-level]: https://github.com/Level/classic-level
[couchdb]: https://couchdb.apache.org/

## Quick start

```js
import cardcatalog from '@livingroom/cardcatalog';
import { once } from 'events';

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

for await (const match of catalog.indexes.byAuthor.getMany('Le Guin')) {
    console.log(match.path, '→', match.indexValue);
}
```

Drop a new file into `./books` and it's indexed automatically; delete one and
its entries disappear.

## Usage

When a file is created or modified, it is run through each index's
`process(fileBuffer, emit, { path })` function. `emit(key, value)` may be called
zero, one, or multiple times, and each call adds an index entry pointing back to
the processed file. If the file is modified later, an atomic transaction drops
any associated index entries and repopulates them via another call to
`process()`. When a file is deleted, all associated index entries are dropped.

Indexes are persisted to disk in LevelDB, and records are kept of the
last-modified time of each file. On startup, `cardcatalog` scans each file in
the directory, consults each index, and--if the file has been modified since the
last run--`process()`es it anew. Files that have not changed since the last time
they were `process()`ed are ignored at startup.

`emit()` keys must be (possibly nested) arrays of strings, numbers, booleans,
and `null`s. Non-array keys will be coerced into singleton arrays (e.g.,
`emit(5, <value>)` emits to the key `[5]`, retrievable as either `5` or `[5]`,
and reported back as `5`). `undefined` is rejected anywhere in a key: it is
reserved as the internal range-scan sentinel.

Indexes may later be queried with `getMany(keyPrefix)`, which will return all
entries with keys of the form `[...keyPrefix, ...other]` (including exact
matches) or `getRange()`, which can return all keys between a lower and upper
bound. Ordering is defined by [charwise].

[charwise]: https://github.com/dominictarr/charwise

If `process()` throws or rejects, no index entries are added to the index, that
document is added to the index's "problem set" (queryable by `problems()`) and a
`problem` event is emitted. Any entries emitted before the throw are discarded,
as are any left over from a previous run. The document is retried the next time
the file changes, on the next `reindex()`, or at the next startup.

## API

### `cardcatalog(indexes, opts?) => catalog`

`indexes` is a `{ [indexName]: <indexOptions> }` map, where each `indexOptions`
may provide:

- `process(content, emit, { path })` - **required**, may be async. `content` is
  a `Buffer` (see [Decoding is your job](#decoding-is-your-job)); call
  `emit(key, value)` any number of times. `path` is the document's
  `dataPath`-relative path.
- `valueEncoding` - Level encoding for emitted values (default `'utf8'`;
  `'json'` is handy).

`opts` provides further `cardcatalog` options:

- `dataPath` - directory of documents to watch (default `'./db'`, created if
  missing).
- `indexPath` - where the index databases live (default `'./index'`, created if
  missing).
- `shouldIndex(relPath, stats?)` - determines whether a document in the watched
  directory is indexed or not. Return `true` for documents that should be
  indexed and `false` for those that should be skipped. Consulted for every
  document, whether it arrives by a watcher event or by `reindex()`, and on
  deletion as well, so a skipped document is never touched in either direction.
  `stats` is present when the file exists and absent when it has been deleted.
- `chokidar` - options passed verbatim to
  [`chokidar.watch`](https://github.com/paulmillr/chokidar#getting-started) for
  watcher tuning (see [Partially-written files](#partially-written-files)).

### `catalog`

- `catalog.indexes.<name>.get(key)` - the single match for `key`, or `null` if
  no such index entry exists. Throws if there is more than one such entry.
- `catalog.indexes.<name>.getMany(key)` - async generator over every match
  for `key`, including compound keys it prefixes.
- `catalog.indexes.<name>.getRange({ gt, gte, lt, lte, reverse, limit })` -
  async generator over a key range. Bounds have the same subtree semantics as
  `getMany`: `gte`/`lte` include the bounding key's whole subtree, `gt`/`lt`
  skip past it. Omitted bounds are open ends; `reverse` walks high-to-low;
  `limit` caps yielded entries (applied after reversal).
- `catalog.indexes.<name>.problems()` - async generator over this index's
  quarantined documents: `{ path, at, message, stack }`, as recorded when
  `process` threw.
- `catalog.reindex(path)` - forces reindexing of the document at the specified
  path immediately. Returns a promise that resolves when the index is up to date
  for the specified document. Useful for read-your-writes situations. Resolves
  to `true` if the document was handled, or `false` if `shouldIndex()` filtered
  it out. Note that "handled" doesn't guarantee `process()` ran: a deleted
  document is de-indexed instead, and one whose mtime hasn't moved since it was
  last indexed is skipped as already up to date. Path should be
  `dataPath`-relative or absolute.
- `catalog.close()` - stop watching, drain pending work, close the databases.
  Returns a promise that resolves when cleanup is complete.
- Event `'idle'` - emitted whenever the catalog goes fully quiescent: the
  initial sweep has been enumerated _and_ every queued update has been
  applied. The first `'idle'` doubles as a ready signal; later ones mean
  "caught up again".
- Event `'problem'` - `{ index, path, error }`, emitted each time a document
  is quarantined (including repeat failures on retry).
- Event `'resolved'` - `{ index, path }`, emitted when a previously
  quarantined document is successfully reindexed or removed. Between these
  two events you never need to poll `problems()`.
- Event `'error'` - infrastructure failures: watcher errors, unreadable
  files, index-database trouble. Standard EventEmitter semantics, so with no
  listener attached this throws. Note the split: a document whose `process`
  throws is a `'problem'`, not an `'error'`; and a failed `reindex()` rejects
  its own promise instead of emitting here, so every failure is reported
  exactly once.

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

## TypeScript

Types ship with the package--no `@types` install. Index names are tracked
through the factory, so `catalog.indexes.byAuthor` is known and a typo is a
compile error. Emitted value types flow through to matches when a config is
annotated:

```ts
import cardcatalog from '@livingroom/cardcatalog';
import type { IndexConfig } from '@livingroom/cardcatalog';

const indexes: Record<'byAuthor', IndexConfig<{ title: string }>> = {
    byAuthor: {
        valueEncoding: 'json',
        process: (content, emit) => emit('Le Guin', { title: 'Earthsea' }),
    },
};

const match = await cardcatalog(indexes).indexes.byAuthor.get('Le Guin');
match?.indexValue.title; // string
```

Without an annotation, `indexValue` is `unknown` rather than `any`, so it has
to be narrowed. `Key` excludes `undefined`, matching the runtime guard.

## Gotchas

### Partially-written files

The watcher can fire while a document is still being written, indexing half a
file. The robust fix is on the writer's side: write to a temp file and
`rename` it into the watched directory. Renames are atomic, so the watcher
only ever sees complete documents.

If you don't control the writer, chokidar's `awaitWriteFinish` holds events
until a file's size has been stable for a while:

```js
const catalog = cardcatalog(indexes, {
    chokidar: { awaitWriteFinish: true },
});
```

Two costs to know about: every watcher-driven update now lags by the
stability threshold (2 seconds by default), and held initial-scan events
arrive _after_ chokidar finishes enumerating, so the first `'idle'` can fire
before pre-existing documents are indexed. Prefer write-then-rename when you
can.

### Decoding is your job

`process` receives a raw [Buffer]. In the likely event you're indexing text
files, you'll need to either `buffer.toString('utf8')` for lax interpretation
with the danger of [mojibake] or use a [TextDecoder] in `fatal` mode for strict
interpretation that throws on invalidly-encoded characters (resulting in the
document being added to the problem set.)

[Buffer]: https://nodejs.org/api/buffer.html
[mojibake]: https://en.wikipedia.org/wiki/Mojibake
[TextDecoder]: https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder

An example of the latter:

```js
const utf8 = new TextDecoder('utf-8', { fatal: true });

const catalog = cardcatalog({
    words: {
        process: (content, emit) => {
            // Throws on invalid UTF-8, so a stray binary file lands in the
            // problem set instead of being indexed as garbage.
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

## License

[ISC](./LICENSE)
