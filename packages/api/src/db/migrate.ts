/** Applies numbered .sql migrations in order, once each. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.ts';
import { createDb } from './index.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db, opts: { quiet?: boolean } = {}): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM _migrations')).map((r) => r.name),
  );

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration is atomic: it applies completely or not at all.
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO _migrations(name) VALUES ($1)', [file]);
    });
    applied.push(file);
    if (!opts.quiet) console.log(`applied ${file}`);
  }
  if (!opts.quiet && applied.length === 0) console.log('no pending migrations');
  return applied;
}

// Run directly:  node src/db/migrate.ts
if (import.meta.filename === process.argv[1]) {
  const db = await createDb();
  await migrate(db);
  await db.close();
}
