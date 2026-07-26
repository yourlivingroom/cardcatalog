// Type-level tests. These are checked by `npm run typecheck` (tsc --noEmit),
// not executed — a compile error here is a failing test. Negative cases use
// the ts-expect-error directive, which itself errors if the line below it
// stops being an error, so the assertions hold in both directions.
import type { EventEmitter } from 'node:events';

import cardcatalog from '../index.mjs';
import type {
    Catalog,
    Index,
    IndexConfig,
    Key,
    Match,
    Problem,
    ProblemEvent,
    ResolvedEvent,
} from '../index.mjs';

type Equal<A, B> =
    (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
        ? true
        : false;
type Expect<T extends true> = T;

// --- The factory and its options ------------------------------------------

const catalog = cardcatalog(
    {
        words: {
            valueEncoding: 'json',
            process: (content, emit, context) => {
                type _Content = Expect<Equal<typeof content, Buffer>>;
                type _Path = Expect<Equal<typeof context.path, string>>;
                emit('key', 'value');
                emit(['compound', 1, true, null], 'value');
            },
        },
        byTag: {
            process: async () => {},
        },
    },
    {
        dataPath: './db',
        indexPath: './index',
        shouldIndex: (path, stats) => {
            type _Path = Expect<Equal<typeof path, string>>;
            return !path.endsWith('.tmp') && stats?.isFile() !== false;
        },
        chokidar: { awaitWriteFinish: true },
    },
);

// The factory's return is a Catalog, and a Catalog is an EventEmitter.
const asCatalog: Catalog = catalog;
const asEmitter: EventEmitter = catalog;
void asCatalog;
void asEmitter;

// opts is optional, as is every field in it.
cardcatalog({ words: { process: () => {} } });
cardcatalog({ words: { process: () => {} } }, {});

// @ts-expect-error - process is required
cardcatalog({ words: {} });

// @ts-expect-error - process must be callable
cardcatalog({ words: { process: 'nope' } });

// @ts-expect-error - indexes is required
cardcatalog();

// @ts-expect-error - unknown option
cardcatalog({ words: { process: () => {} } }, { dataPaths: './db' });

// @ts-expect-error - dataPath is a string
cardcatalog({ words: { process: () => {} } }, { dataPath: 5 });

// --- Index names are known statically -------------------------------------

type _Names = Expect<Equal<keyof typeof catalog.indexes, 'words' | 'byTag'>>;

catalog.indexes.words;
catalog.indexes.byTag;

// @ts-expect-error - no such index
catalog.indexes.nope;

// The deprecated alias exposes the same surface.
type _AliasMatchesIndexes = Expect<
    Equal<typeof catalog.catalogs, typeof catalog.indexes>
>;

// --- Queries ---------------------------------------------------------------

async function queries() {
    const got = await catalog.indexes.words.get('key');
    type _Get = Expect<Equal<typeof got, Match<unknown> | null>>;

    // Keys accept every charwise-encodable shape, including nesting.
    await catalog.indexes.words.get(null);
    await catalog.indexes.words.get(true);
    await catalog.indexes.words.get(42);
    await catalog.indexes.words.get(['a', ['b', 3], null]);

    // @ts-expect-error - undefined is the reserved range sentinel
    await catalog.indexes.words.get(undefined);

    // @ts-expect-error - and it is rejected when nested, too
    await catalog.indexes.words.get(['a', undefined]);

    // @ts-expect-error - objects are not charwise keys
    await catalog.indexes.words.get({ a: 1 });

    for await (const match of catalog.indexes.words.getMany('key')) {
        type _Key = Expect<Equal<typeof match.key, Key>>;
        type _Path = Expect<Equal<typeof match.path, string>>;

        // Checked by calling, not via ReturnType — these are overloads, and
        // ReturnType only ever sees the last signature.
        const raw = await match.read();
        type _Raw = Expect<Equal<typeof raw, Buffer>>;

        const text = await match.read('utf8');
        type _Text = Expect<Equal<typeof text, string>>;

        const bytes = match.readSync();
        type _Bytes = Expect<Equal<typeof bytes, Buffer>>;

        const syncText = match.readSync('utf8');
        type _SyncText = Expect<Equal<typeof syncText, string>>;
    }

    catalog.indexes.words.getRange();
    catalog.indexes.words.getRange({});
    catalog.indexes.words.getRange({ gte: 'a', lt: ['b', 2] });
    catalog.indexes.words.getRange({ reverse: true, limit: 10 });

    // @ts-expect-error - limit is a number
    catalog.indexes.words.getRange({ limit: 'ten' });

    // @ts-expect-error - unknown range option
    catalog.indexes.words.getRange({ gtee: 'a' });

    for await (const problem of catalog.indexes.words.problems()) {
        type _Problem = Expect<Equal<typeof problem, Problem>>;
        problem.path.trim();
        problem.message.trim();
        problem.at.trim();
    }
}

// --- Events ----------------------------------------------------------------

catalog.on('idle', () => {});
catalog.on('problem', (event) => {
    type _Event = Expect<Equal<typeof event, ProblemEvent>>;
    event.error.message;
});
catalog.on('resolved', (event) => {
    type _Event = Expect<Equal<typeof event, ResolvedEvent>>;
    event.index;
    event.path;
});
catalog.on('error', (error) => {
    type _Error = Expect<Equal<typeof error, Error>>;
});
catalog.once('idle', () => {});
catalog.off('idle', () => {});

// @ts-expect-error - unknown event
catalog.on('nope', () => {});

// @ts-expect-error - 'idle' listeners take no arguments
catalog.on('idle', (payload: string) => {});

// --- Catalog surface -------------------------------------------------------

async function surface() {
    type _DataPath = Expect<Equal<typeof catalog.dataPath, string>>;
    type _IndexPath = Expect<Equal<typeof catalog.indexPath, string>>;

    const reindexed = await catalog.reindex('doc1');
    type _Reindex = Expect<Equal<typeof reindexed, void>>;

    await catalog.close();

    // @ts-expect-error - reindex takes a path
    await catalog.reindex(5);
}

// --- Value typing ----------------------------------------------------------

// An explicitly annotated config carries its value type through to matches.
const typed: Record<'byAuthor', IndexConfig<{ title: string }>> = {
    byAuthor: {
        valueEncoding: 'json',
        process: (content, emit) => emit('author', { title: 'Earthsea' }),
    },
};

async function values() {
    const typedCatalog = cardcatalog(typed);
    const match = await typedCatalog.indexes.byAuthor.get('author');
    type _Value = Expect<
        Equal<NonNullable<typeof match>['indexValue'], { title: string }>
    >;

    const index: Index<{ title: string }> = typedCatalog.indexes.byAuthor;
    void index;
}

export {};
