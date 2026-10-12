/**
 * Test support for the durable suggestion store.
 *
 * The plugin persists through `ctx.storageDomain.open(spec)`, which
 * `@deepseek-ai/dsh-base` provides in every real profile. Unit tests need the
 * same seam without booting a storage backend, so this module installs a
 * minimal in-memory `storageDomain` service whose `open` returns a domain with
 * the `table(name)` face the plugin uses (`get` / `put` / `delete`).
 *
 * The double is deliberately shallow: it reproduces the contract the plugin
 * depends on (keyed whole-value records) and nothing else, so a test that
 * reaches for behaviour the real domain does not have fails here first.
 * @module tests/storage
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SuggestPromptStorageRecord } from '../src/domain.ts'

/** One in-memory table of whole-value records keyed by string. */
export interface FakeTable {
  get(key: string): unknown
  keys(): string[]
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

/** The in-memory store a test can inspect after the plugin has written. */
export interface FakeStorageDomain {
  /** The `sessions` table, keyed by session id. */
  table(name: string): FakeTable
  /** Every record written, for assertions. */
  readonly records: Map<string, SuggestPromptStorageRecord>
  /** Count of `put` calls, to assert a write did (or did not) happen. */
  puts: number
  /** Count of `delete` calls, to assert a stale record was retired. */
  deletes: number
  /** Reject every `put` when set — the store-failure path. */
  failWrites?: Error
}

/**
 * Create an in-memory suggestion domain double.
 * @returns the fake domain plus its inspection surface.
 */
export function createFakeDomain(): FakeStorageDomain {
  const records = new Map<string, SuggestPromptStorageRecord>()
  const state = {
    records,
    puts: 0,
    deletes: 0,
    failWrites: undefined as Error | undefined,
  }
  const table: FakeTable = {
    get: (key: string) => records.get(key),
    keys: () => [...records.keys()],
    put: async (key: string, value: unknown) => {
      if (state.failWrites !== undefined) throw state.failWrites
      state.puts += 1
      records.set(key, value as SuggestPromptStorageRecord)
    },
    delete: async (key: string) => {
      state.deletes += 1
      return records.delete(key)
    },
  }
  return {
    table: (name: string) => {
      if (name !== 'sessions') throw new Error(`unexpected table ${name}`)
      return table
    },
    get records() {
      return records
    },
    get puts() {
      return state.puts
    },
    set puts(value: number) {
      state.puts = value
    },
    get deletes() {
      return state.deletes
    },
    set deletes(value: number) {
      state.deletes = value
    },
    get failWrites() {
      return state.failWrites
    },
    set failWrites(value: Error | undefined) {
      state.failWrites = value
    },
  }
}

/**
 * Install the in-memory domain as `ctx.storageDomain`, so the plugin's
 * `open(spec)` resolves to {@link createFakeDomain}.
 *
 * The service is registered on the plugin's own context: the plugin declares
 * `storageDomain` in its inject list, so a test that mounts it through the
 * loader must provide the service before the plugin activates.
 * @param ctx - the context the plugin will be mounted on.
 * @param domain - the fake to serve, already created by the caller so the test
 *   keeps a handle for assertions.
 */
export function installFakeStorage(ctx: Context, domain: FakeStorageDomain): void {
  ctx.provide('storageDomain', {
    async open() {
      return domain
    },
  } as never)
}