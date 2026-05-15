// Resend email wrapper. No-ops with a console log when RESEND_API_KEY is unset
// (useful for local dev — the magic-link URL is logged so devs can copy/paste).

import { Resend } from 'resend';
import { env } from '../env.js';
import { log } from '../log.js';

let client: Resend | null = null;
function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export async function sendMagicLink(opts: { to: string; url: string }): Promise<void> {
  const c = getClient();
  if (!c) {
    // Dev mode: print prominently so it survives any log-level filtering and
    // is easy to spot in mixed Hono/pino output.
    log.info({ to: opts.to, url: opts.url }, 'magic-link (RESEND_API_KEY unset)');
    // eslint-disable-next-line no-console
    console.log(`\n  → magic link for ${opts.to}:\n    ${opts.url}\n`);
    return;
  }
  const subject = 'Your Feed Sorter sign-in link';
  const text = `Click to sign in: ${opts.url}\n\nThis link expires in 15 minutes.`;
  const html = `
    <p>Click to sign in:</p>
    <p><a href="${opts.url}">${opts.url}</a></p>
    <p>This link expires in 15 minutes.</p>
  `;
  await c.emails.send({
    from: env.RESEND_FROM,
    to: opts.to,
    subject,
    text,
    html,
  });
}
