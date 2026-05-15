// Startup migration runner. Invoked on container start before the API
// process begins serving requests.
//
// Drizzle migrations are generated via `npm run db:generate` (drizzle-kit)
// and committed under `apps/api/drizzle/`. This runner applies any pending
// migrations against DATABASE_URL.

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is required');
    process.exit(1);
  }

  // pgvector + citext must exist before drizzle migrations reference them.
  const bootstrap = postgres(url, { max: 1 });
  try {
    await bootstrap.unsafe('create extension if not exists vector');
    await bootstrap.unsafe('create extension if not exists citext');
  } finally {
    await bootstrap.end({ timeout: 5 });
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  console.log('[migrate] running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[migrate] done');

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
