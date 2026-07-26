/// <reference types="node" />

import type { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';
import type { ChokidarOptions } from 'chokidar';

/**
 * Anything charwise can encode. `undefined` is deliberately absent: it is
 * reserved as the internal range-scan sentinel and is rejected at runtime
 * wherever a key is accepted.
 */
export type Key = null | boolean | number | string | Key[];

/** Level value encodings; a custom codec object is also accepted. */
export type ValueEncoding = 'utf8' | 'json' | 'buffer' | 'view' | object;

/** A single index's configuration. */
export interface IndexConfig<Value = unknown> {
    /**
     * Maps a document to index entries. Call `emit` any number of times; a
     * throw quarantines the document (see `problems()`).
     */
    process(
        content: Buffer,
        emit: (key: Key, value: Value) => void,
        context: { path: string },
    ): void | Promise<void>;

    /** How emitted values are stored. Defaults to `'utf8'`. */
    valueEncoding?: ValueEncoding;
}

export interface CatalogOptions {
    /** Directory of documents to watch. Default `'./db'`, created if missing. */
    dataPath?: string;

    /** Where the index databases live. Default `'./index'`. */
    indexPath?: string;

    /** Return false to skip a document. `path` is dataPath-relative. */
    shouldIndex?(path: string, stats?: Stats): boolean;

    /** Passed verbatim to `chokidar.watch`. */
    chokidar?: ChokidarOptions;
}

/** One entry from `get`, `getMany`, or `getRange`. */
export interface Match<Value = unknown> {
    /** The emitted key: the scalar itself, or the array for compound keys. */
    key: Key;

    /** The document's path, relative to `dataPath`, always `/`-separated. */
    path: string;

    /** The emitted value. */
    indexValue: Value;

    /** Reads the document. Mirrors `fs.promises.readFile`. */
    read(): Promise<Buffer>;
    read(
        options: {
            encoding?: null | undefined;
            flag?: string | undefined;
        } | null,
    ): Promise<Buffer>;
    read(
        options:
            | BufferEncoding
            | { encoding: BufferEncoding; flag?: string | undefined },
    ): Promise<string>;

    /** Reads the document synchronously. Mirrors `fs.readFileSync`. */
    readSync(): Buffer;
    readSync(
        options: {
            encoding?: null | undefined;
            flag?: string | undefined;
        } | null,
    ): Buffer;
    readSync(
        options:
            | BufferEncoding
            | { encoding: BufferEncoding; flag?: string | undefined },
    ): string;
}

/**
 * Bounds inherit `getMany`'s prefix semantics: each addresses a key's whole
 * subtree, so `gte`/`lte` include the bounding key's subtree while `gt`/`lt`
 * skip past it. Omitted bounds are open ends.
 */
export interface RangeQuery {
    gt?: Key;
    gte?: Key;
    lt?: Key;
    lte?: Key;

    /** Walk the range high-to-low. */
    reverse?: boolean;

    /** Cap on entries yielded; applies after reversal. */
    limit?: number;
}

/** A quarantined document, as recorded when `process` threw. */
export interface Problem {
    /** The document's path, relative to `dataPath`. */
    path: string;

    /** ISO timestamp of the failure. */
    at: string;

    message: string;
    stack?: string;
}

/** The query surface for one named index. */
export interface Index<Value = unknown> {
    /**
     * The single match for `key`, or `null` if there is none.
     *
     * @throws if several documents match — calling `get` asserts the key is
     * unique.
     */
    get(key: Key): Promise<Match<Value> | null>;

    /**
     * Every match for `key`, including compound keys it prefixes: given
     * `emit(['tag', t], …)`, `getMany(['tag'])` yields every tag entry.
     */
    getMany(key: Key): AsyncGenerator<Match<Value>, void, undefined>;

    /** Every match within a key range. */
    getRange(range?: RangeQuery): AsyncGenerator<Match<Value>, void, undefined>;

    /** This index's quarantined documents. */
    problems(): AsyncGenerator<Problem, void, undefined>;
}

export interface ProblemEvent {
    index: string;
    path: string;
    error: Error;
}

export interface ResolvedEvent {
    index: string;
    path: string;
}

/**
 * An index config whose value type is unconstrained — the generic bound for
 * anything accepting arbitrary index maps. `IndexConfig` is covariant in its
 * value, so this must be `any` rather than `unknown` or `never`.
 */
export type AnyIndexConfig = IndexConfig<any>;

type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The value type an index config emits. Configs written inline without an
 * annotation infer `any` for the emitted value; that becomes `unknown` here,
 * so a match's `indexValue` always has to be narrowed rather than silently
 * escaping type checking.
 */
export type ValueOf<C> =
    C extends IndexConfig<infer Value>
        ? IsAny<Value> extends true
            ? unknown
            : Value
        : unknown;

/** Maps each index config to its query surface, preserving value types. */
export type Indexes<T extends Record<string, AnyIndexConfig>> = {
    [K in keyof T]: Index<ValueOf<T[K]>>;
};

export interface CatalogEvents {
    /**
     * The catalog is fully quiescent: the initial sweep has been enumerated
     * and every queued update applied. The first `'idle'` doubles as a ready
     * signal.
     */
    idle: [];

    /** A document was quarantined. Fires on each failure, including retries. */
    problem: [event: ProblemEvent];

    /** A previously quarantined document was reindexed or removed. */
    resolved: [event: ResolvedEvent];

    /**
     * An infrastructure failure: watcher errors, unreadable files, index
     * database trouble. Standard EventEmitter semantics — unhandled, this
     * throws.
     */
    error: [error: Error];
}

export interface Catalog<
    T extends Record<string, AnyIndexConfig> = Record<string, AnyIndexConfig>,
> extends EventEmitter {
    /** The query surface, keyed by index name. */
    readonly indexes: Indexes<T>;

    /** @deprecated Use {@link Catalog.indexes} instead. */
    readonly catalogs: Indexes<T>;

    /** The resolved absolute watch root. */
    readonly dataPath: string;

    /** Where the index databases live. */
    readonly indexPath: string;

    /**
     * Index (or, if the file is gone, de-index) a document now rather than
     * waiting for the watcher, resolving once done. Accepts a dataPath-
     * relative or absolute path; rejects paths outside `dataPath`.
     */
    reindex(path: string): Promise<void>;

    /** Stop watching, drain pending work, and close the databases. */
    close(): Promise<void>;

    on<E extends keyof CatalogEvents>(
        event: E,
        listener: (...args: CatalogEvents[E]) => void,
    ): this;
    once<E extends keyof CatalogEvents>(
        event: E,
        listener: (...args: CatalogEvents[E]) => void,
    ): this;
    off<E extends keyof CatalogEvents>(
        event: E,
        listener: (...args: CatalogEvents[E]) => void,
    ): this;
    addListener<E extends keyof CatalogEvents>(
        event: E,
        listener: (...args: CatalogEvents[E]) => void,
    ): this;
    removeListener<E extends keyof CatalogEvents>(
        event: E,
        listener: (...args: CatalogEvents[E]) => void,
    ): this;
    emit<E extends keyof CatalogEvents>(
        event: E,
        ...args: CatalogEvents[E]
    ): boolean;
}

/**
 * Builds a catalog: persistent, incrementally-maintained LevelDB indexes over
 * the documents in a watched directory.
 *
 * @throws TypeError on invalid configuration, before anything touches disk.
 */
export default function cardcatalog<T extends Record<string, AnyIndexConfig>>(
    indexes: T,
    opts?: CatalogOptions,
): Catalog<T>;
