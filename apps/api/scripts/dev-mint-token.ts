// Dev-only: mint a fresh JWT for a user (by email) using the current DB tier
// and DB-issued user id. Prints the token + a one-line snippet you can paste
// into the extension's chrome.storage.local from any extension page DevTools
// console (popup, options, dashboard).
//
// Usage:
//   tsx scripts/dev-mint-token.ts <email>
//
// Refuses to run when NODE_ENV=production. Requires DATABASE_URL + JWT_SECRET.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import { createSessionToken } from '../src/auth/jwt.js';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to mint dev tokens in production.');
    process.exit(2);
  }
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: tsx scripts/dev-mint-token.ts <email>');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is required (must match the API server).');
    process.exit(2);
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);
  try {
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!u) {
      console.error(`No user found with email=${email}.`);
      process.exit(1);
    }
    const { token, expiresAt } = await createSessionToken({
      sub: u.id,
      email: u.email,
      tier: u.tier as 'free' | 'pro' | 'studio',
    });
    console.log('');
    console.log(`✓ Minted JWT for ${u.email} (tier=${u.tier}, expires ${expiresAt.toISOString()})`);
    console.log('');
    console.log('Token:');
    console.log(token);
    console.log('');
    console.log('— Paste this into the EXTENSION DevTools console (open the popup or');
    console.log('  options page, right-click → Inspect, then Console tab):');
    console.log('');
    console.log(
      `chrome.storage.local.set({ "fs.api.token": ${JSON.stringify(token)} }, () => console.log("token set"));`,
    );
    console.log('');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
