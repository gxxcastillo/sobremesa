/**
 * Minimal fake `DatabaseClient` for authz boundary tests.
 *
 * Item D's test matrix exercises the auth guard layer (401/403 decisions),
 * not each route's business logic. The only DB-touching step reached before
 * a guard's `beforeHandle` runs is `createAuthPlugin`'s `.derive()`, which
 * makes exactly three calls, all simple filters against in-memory fixture
 * rows:
 *   1. `users.select('*').eq('id', ...).single()`
 *   2. `identities.select('*').eq('id', ...).single()`
 *   3. `family_access.select('*').eq('identity_id', ...).order(...).eq('status', 'active')`
 *
 * This fake supports exactly the query-builder chain shapes those calls (and
 * the handful of simple lookups used by the "guard passes" test cases, e.g.
 * `families.findAllActive()`) need: `select/eq/neq/in/order/limit/range/ilike/or`
 * as no-op-or-filter chain steps, `single()` for a single-row result, and
 * plain `await` (via `.then()`) for a list result. It does NOT implement
 * `.insert()`/`.update()`/`.rpc()` with real semantics — those are only
 * reached by 200-path business logic, which is out of scope for the authz
 * boundary this test matrix covers (see `.agents/extraction-hardening-plan.md`
 * item D). Calling them is harmless: they return an empty/no-op result
 * rather than throwing, so a route whose guard passes doesn't crash the
 * test — it just won't do anything useful past that point, which is fine
 * since these tests don't assert on 200-path response bodies.
 */
import type { DatabaseClient } from '@sobremesa/database';

export type FakeRow = Record<string, unknown>;
export type FakeFixtures = Record<string, FakeRow[]>;

interface FakeResult {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number;
}

function createQueryBuilder(rows: FakeRow[]) {
  let filtered = [...rows];

  const builder = {
    select: () => builder,
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    delete: () => builder,
    eq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val);
      return builder;
    },
    neq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] !== val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filtered = filtered.filter((r) => vals.includes(r[col]));
      return builder;
    },
    gte: () => builder,
    lte: () => builder,
    ilike: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    single: (): Promise<FakeResult> => {
      const row = filtered[0];
      if (!row) {
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST116', message: 'No rows found' },
        });
      }
      return Promise.resolve({ data: row, error: null });
    },
    // Supabase's query builder is a thenable that executes lazily on
    // `await`/`.then()`. Chains that never call `.single()` (e.g.
    // `family_access.findByIdentity`) rely on that here.
    then: (
      resolve: (value: FakeResult) => unknown,
      reject?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({
        data: filtered,
        error: null,
        count: filtered.length,
      }).then(resolve, reject),
  };

  return builder;
}

/**
 * Build a fake `DatabaseClient` backed by in-memory fixture rows, keyed by
 * table name (snake_case, matching the real schema). Unlisted tables behave
 * as if empty rather than throwing.
 */
export function createFakeDbClient(
  fixtures: FakeFixtures = {},
): DatabaseClient {
  return {
    from(table: string) {
      return createQueryBuilder(fixtures[table] ?? []);
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as DatabaseClient;
}
