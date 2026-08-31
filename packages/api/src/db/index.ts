/**
 * Database access layer.
 *
 * Two adapters, one interface and ONE dialect of SQL:
 *   - PGlite  : real PostgreSQL 16 compiled to WASM. Used for tests and for
 *               local development with no server to install.
 *   - node-pg : a real PostgreSQL server. Used in production.
 *
 * Both run identical SQL, so the acceptance tests in test/ exercise the same
 * queries production does - including transaction and locking semantics,
 * which this domain genuinely depends on.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Exactly one row expected; throws otherwise. */
  one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T>;
  /** Zero or one row expected. */
  maybeOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /**
   * Run fn inside a transaction, committing on success and rolling back on
   * any thrown error. Every money-moving operation in this system runs
   * inside one of these.
   */
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * NOTE: this codebase runs on Node type-stripping, so it must stay within
 * "erasable" TypeScript - no parameter properties, no enums, no namespaces.
 * Fields are declared and assigned explicitly.
 */
class QueryError extends Error {
  sql: string;
  params: readonly unknown[];
  constructor(message: string, sql: string, params: readonly unknown[]) {
    super(`${message}\n  SQL: ${sql.trim().split('\n')[0]}`);
    this.name = 'QueryError';
    this.sql = sql;
    this.params = params;
  }
}

/**
 * `runner` uses the extended (parameterised) protocol, which accepts exactly
 * one statement. `execRunner` uses the simple protocol, which accepts a whole
 * multi-statement script - that is what migrations need.
 */
function wrap(
  runner: (sql: string, params: readonly unknown[]) => Promise<unknown[]>,
  execRunner: (sql: string) => Promise<void>,
): Queryable {
  const q: Queryable = {
    async query(sql, params = []) {
      return (await runner(sql, params)) as never;
    },
    async one(sql, params = []) {
      const rows = await runner(sql, params);
      if (rows.length !== 1) {
        throw new QueryError(`expected exactly 1 row, got ${rows.length}`, sql, params);
      }
      return rows[0] as never;
    },
    async maybeOne(sql, params = []) {
      const rows = await runner(sql, params);
      if (rows.length > 1) {
        throw new QueryError(`expected at most 1 row, got ${rows.length}`, sql, params);
      }
      return (rows[0] ?? null) as never;
    },
    async exec(sql) {
      await execRunner(sql);
    },
  };
  return q;
}

/* ------------------------------------------------------------------ */
/* PGlite adapter                                                      */
/* ------------------------------------------------------------------ */

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) {
    // PGlite opens the directory but will not create missing parents.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });
  }
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;

  const base = wrap(
    async (sql, params) => {
      const res = await pg.query(sql, params as unknown[]);
      return res.rows as unknown[];
    },
    async (sql) => {
      await pg.exec(sql);
    },
  );

  let depth = 0;
  return {
    ...base,
    async tx(fn) {
      // PGlite is single-connection, so nested tx() calls join the outer
      // transaction rather than opening a second one.
      if (depth > 0) return fn(base);
      depth++;
      try {
        await pg.exec('BEGIN');
        const out = await fn(base);
        await pg.exec('COMMIT');
        return out;
      } catch (err) {
        await pg.exec('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        depth--;
      }
    },
    async close() {
      await pg.close();
    },
  };
}

/* ------------------------------------------------------------------ */
/* node-postgres adapter                                               */
/* ------------------------------------------------------------------ */

export async function createPostgresDb(connectionString: string): Promise<Db> {
  const pgMod = await import('pg');
  const Pool = pgMod.default.Pool;
  const pool = new Pool({ connectionString });

  const base = wrap(
    async (sql, params) => {
      const res = await pool.query(sql, params as unknown[]);
      return res.rows;
    },
    async (sql) => {
      await pool.query(sql);
    },
  );

  return {
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      const scoped = wrap(
        async (sql, params) => {
          const res = await client.query(sql, params as unknown[]);
          return res.rows;
        },
        async (sql) => {
          await client.query(sql);
        },
      );
      try {
        await client.query('BEGIN');
        const out = await fn(scoped);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Pick an adapter from the environment. DATABASE_URL selects real Postgres. */
export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith('postgres')) return createPostgresDb(url);
  return createPgliteDb(process.env.PGLITE_DIR ?? './.data/alkavida');
}
