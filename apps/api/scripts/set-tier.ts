// Set a user's tier directly in the DB.
//
// Usage:
//   tsx scripts/set-tier.ts <email> <free|pro|studio>
//   tsx scripts/set-tier.ts --all pro             # bulk: every user
//
// Requires DATABASE_URL. Intended for local dev / break-glass; prefer Stripe
// in production.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';

const VALID_TIERS = new Set(['free', 'pro', 'studio']);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: tsx scripts/set-tier.ts <email|--all> <free|pro|studio>');
    process.exit(2);
  }
  const [target, tier] = args;
  if (!VALID_TIERS.has(tier)) {
    console.error(`Invalid tier "${tier}". Must be one of: ${[...VALID_TIERS].join(', ')}`);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    if (target === '--all') {
      const rows = await db.update(users).set({ tier }).returning({ id: users.id, email: users.email });
      console.log(`Updated ${rows.length} user(s) to tier=${tier}.`);
    } else {
      const rows = await db
        .update(users)
        .set({ tier })
        .where(eq(users.email, target))
        .returning({ id: users.id, email: users.email, tier: users.tier });
      if (rows.length === 0) {
        console.error(`No user found with email=${target}.`);
        process.exit(1);
      }
      console.log(`✓ ${rows[0].email} → tier=${rows[0].tier}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
