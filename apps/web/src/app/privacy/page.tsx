// Privacy Policy. Public route — no auth required (see middleware PUBLIC set).
// Template copy: have a lawyer review before public launch.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — Feed Sorter',
  description: 'How Feed Sorter handles your data.',
};

const LAST_UPDATED = 'May 14, 2026';

export default function PrivacyPage() {
  return (
    <article className="max-w-3xl mx-auto py-6">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="text-sm text-zinc-500 mt-2">Last updated: {LAST_UPDATED}</p>
      </header>

      <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
        <Section title="1. What we collect">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong>Email address.</strong> Used for magic-link sign-in and
              transactional email (receipts, security notices). That&apos;s the only
              account credential we hold.
            </li>
            <li>
              <strong>Billing identifiers.</strong> Stripe customer ID and the last 4
              digits of your card, returned to us by Stripe for display in the Billing
              page. We never see the full card number, CVC, or expiry.
            </li>
            <li>
              <strong>Captured posts you sync.</strong> Post URLs, captions, view/like
              counts, posted timestamps, and the AI analyses we run on them (transcripts,
              format labels, hooks, niche tags, cover diagnostics). This is the data
              that powers your Library.
            </li>
            <li>
              <strong>Standard request metadata.</strong> IP address and User-Agent on
              API requests, logged for abuse prevention and debugging.
            </li>
            <li>
              <strong>Usage counters.</strong> Per-period counts of analyses,
              transcriptions, and syncs to enforce plan caps.
            </li>
          </ul>
        </Section>

        <Section title="2. What we do NOT collect">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong>No passwords.</strong> Sign-in is magic-link only; there is no
              password to store, leak, or reset.
            </li>
            <li>
              <strong>No payment card data.</strong> Stripe handles card collection
              under PCI scope; the card never touches our servers.
            </li>
            <li>
              <strong>No keystroke logging, no DOM/screen capture</strong> beyond what
              the extension explicitly captures (the public post payloads as they load
              in your normal feed).
            </li>
            <li>
              <strong>No advertising trackers, no pixels, no analytics SDKs</strong>{' '}
              on the web app or the extension.
            </li>
          </ul>
        </Section>

        <Section title="3. Where data lives">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong>Postgres on Railway (US region).</strong> Primary database for
              accounts, captured posts, analyses, and usage counters.
            </li>
            <li>
              <strong>Cloudflare R2 (reserved).</strong> No object storage in active use
              today; reserved for future cover-image and audio caches if/when they move
              off Postgres.
            </li>
            <li>
              <strong>Analyses cache.</strong> Shared across users, keyed by a hash of
              the public post content. There is no user identifier in the cache key,
              and nothing in the cache row is tied back to who first triggered it.
            </li>
            <li>
              <strong>Per-user Library.</strong> Kept in your account namespace only;
              never served to other users.
            </li>
          </ul>
        </Section>

        <Section title="4. Third parties and what they see">
          <p>
            We send the minimum data necessary to perform each task. Each vendor has its
            own privacy terms; you should review them if you have specific concerns.
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong>Google (Gemini API).</strong> Receives caption text and
              cover-image bytes for analysis (format labels, hook extraction, cover
              diagnostics). We set the abuse-monitoring / training opt-out where Google
              exposes one. Subject to{' '}
              <a
                className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
                href="https://ai.google.dev/gemini-api/terms"
                target="_blank"
                rel="noreferrer noopener"
              >
                Google AI&apos;s usage terms
              </a>
              .
            </li>
            <li>
              <strong>Groq (Whisper API).</strong> Receives audio bytes for
              transcription. Per Groq&apos;s terms, audio is discarded server-side after
              the response is returned.
            </li>
            <li>
              <strong>Stripe.</strong> Receives your billing email, amounts, and card
              details (entered directly on Stripe&apos;s hosted forms). Standard PCI
              processor.
            </li>
            <li>
              <strong>Resend.</strong> Outbound transactional email only — magic-link
              sign-in and receipts. No marketing.
            </li>
            <li>
              <strong>Railway.</strong> Our infrastructure host (compute + Postgres).
              Sees the same data as the database does, at rest.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> share data with advertisers, data brokers, or
            social platforms.
          </p>
        </Section>

        <Section title="5. Retention">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong>Active accounts.</strong> Retained indefinitely while the account
              is in use.
            </li>
            <li>
              <strong>Cancelled accounts.</strong> Per-user data is kept for 90 days
              after cancellation (to support reactivation and export requests), then
              purged.
            </li>
            <li>
              <strong>Analyses cache.</strong> Retained indefinitely. Cache rows are
              keyed by a hash of the public post content and contain no user-identifying
              data, so retention is decoupled from any individual account.
            </li>
            <li>
              <strong>Server logs.</strong> 30 days, then rotated out.
            </li>
          </ul>
        </Section>

        <Section title="6. Your rights">
          <p>You can, at any time:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Request an export of your per-user data.</li>
            <li>Request deletion of your account.</li>
            <li>
              Opt out of cache-sharing for posts you originated (we&apos;ll evict the
              corresponding cache rows on request).
            </li>
            <li>Correct inaccurate account information.</li>
          </ul>
          <p>
            Email{' '}
            <a
              className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
              href="mailto:privacy@feedsorter.app"
            >
              privacy@feedsorter.app
            </a>{' '}
            from your account email. We respond within 30 days.
          </p>
        </Section>

        <Section title="7. Cookies">
          <p>
            We set <strong>one</strong> cookie: the auth session cookie.
            <code className="ml-1 rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
              httpOnly
            </code>
            ,{' '}
            <code className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
              SameSite=Lax
            </code>
            , 30-day expiry. No tracking pixels, no third-party cookies, no
            fingerprinting.
          </p>
        </Section>

        <Section title="8. Children">
          <p>
            Feed Sorter is not directed to children under 13, and we do not knowingly
            collect data from them. If you believe a child has signed up, email
            privacy@feedsorter.app and we&apos;ll delete the account.
          </p>
        </Section>

        <Section title="9. Changes to this policy">
          <p>
            We&apos;ll email active subscribers before material changes take effect. The
            &ldquo;Last updated&rdquo; date at the top always reflects the current
            version.
          </p>
        </Section>

        <Section title="10. Contact">
          <p>
            Privacy questions:{' '}
            <a
              className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
              href="mailto:privacy@feedsorter.app"
            >
              privacy@feedsorter.app
            </a>
            .
          </p>
        </Section>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-zinc-100 mb-2">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
