// Terms of Service. Public route — no auth required (see middleware PUBLIC set).
// Template copy: have a lawyer review before public launch, especially the
// governing-law clause and the cache-sharing consent language.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — Feed Sorter',
  description: 'Terms governing use of Feed Sorter.',
};

const LAST_UPDATED = 'May 14, 2026';

export default function TermsPage() {
  return (
    <article className="max-w-3xl mx-auto py-6">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-sm text-zinc-500 mt-2">Last updated: {LAST_UPDATED}</p>
      </header>

      <div className="space-y-8 text-sm leading-relaxed text-zinc-300">
        <Section title="1. The service">
          <p>
            Feed Sorter is a browser extension and companion web app that captures public
            short-form posts from Instagram, TikTok, and YouTube as you browse, lets you
            sort, filter, and analyze them, and optionally syncs them to a personal
            Library hosted by us. The extension only sees what you visit; it does not
            crawl, scrape headlessly, or solicit content you can&apos;t already see on
            those platforms.
          </p>
        </Section>

        <Section title="2. Public-content cache (cross-user)">
          <p>
            We compute analyses — transcripts, visual format classifications,
            hook/topic/angle labels, and niche labels — of <strong>public</strong> posts
            (reels, TikToks, Shorts) and cache them keyed by post content. Cached
            analyses may be served to other users of the service to keep costs low and
            the product fast. The original public content is unmodified; we never
            re-publish or re-host the underlying video, audio, or imagery on a public
            surface.
          </p>
          <p>
            By using the service, you consent to anonymous, content-keyed sharing of
            derivative analyses for posts you analyze through it. You can opt out of
            cache-sharing for posts you originated — see the Privacy Policy for how.
          </p>
        </Section>

        <Section title="3. Per-user data (private)">
          <p>
            Your captured Library, pins, notes, tags, watchlists, voice fingerprints,
            signals, exports, downloaded video files, and account email are stored
            against your account and are <strong>not</strong> shared with other users.
            We treat this data as yours. We will not sell it, and we will not use it to
            train third-party models.
          </p>
        </Section>

        <Section title="4. Acceptable use">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              Don&apos;t use Feed Sorter in a way that violates the platform terms of
              Instagram, TikTok, or YouTube.
            </li>
            <li>
              Don&apos;t resell, repackage, or redistribute cached analyses as a
              standalone product.
            </li>
            <li>
              Don&apos;t drive the extension at automated rates beyond the natural pace
              of normal browsing (no bots, no headless drivers, no &ldquo;feed
              firehose&rdquo; tooling).
            </li>
            <li>
              Don&apos;t use the service to harass, dox, or target individuals.
            </li>
          </ul>
        </Section>

        <Section title="5. Plans and billing">
          <p>
            Feed Sorter is offered on three tiers: <strong>Free</strong>,{' '}
            <strong>Pro ($19/month)</strong>, and <strong>Studio ($49/month)</strong>.
            Paid plans renew monthly via Stripe until cancelled. You can cancel at any
            time from the Billing page; access remains active through the end of the
            paid period.
          </p>
          <p>
            <strong>Refunds.</strong> New paid subscriptions are refundable in full
            within 14 days of the initial charge. After that, charges are
            non-refundable, but you can cancel future renewals at any time.
          </p>
          <p>
            <strong>Proration.</strong> Upgrading mid-cycle is prorated against the
            remainder of the current period. Downgrading takes effect at the end of the
            current period.
          </p>
        </Section>

        <Section title="6. Termination">
          <p>
            We may suspend or terminate accounts that violate these terms, abuse the
            service, or put it at legal risk. Where reasonable, we&apos;ll give notice
            and a chance to fix the issue. You can request a full export of your
            per-user data before deletion by emailing the contact address in our
            Privacy Policy; we&apos;ll honor reasonable export requests for up to 90
            days after termination.
          </p>
        </Section>

        <Section title="7. Disclaimer of warranty">
          <p>
            The service is provided <strong>AS IS</strong> and <strong>AS AVAILABLE</strong>,
            without warranties of any kind, express or implied — including merchantability,
            fitness for a particular purpose, or non-infringement. We do not guarantee that
            analyses are accurate, that the service will be uninterrupted, or that platform
            integrations (IG/TT/YT) will continue to function as those platforms evolve.
          </p>
        </Section>

        <Section title="8. Limitation of liability">
          <p>
            To the maximum extent permitted by law, our aggregate liability arising out
            of or relating to the service is limited to the greater of (a) the amounts
            you paid us for the service in the 12 months preceding the claim, or (b)
            US&nbsp;$100. We are not liable for indirect, incidental, consequential,
            special, or punitive damages, or for lost profits, lost data, or lost
            business.
          </p>
        </Section>

        <Section title="9. Changes to these terms">
          <p>
            We&apos;ll post material changes here and email active subscribers before
            they take effect. The &ldquo;Last updated&rdquo; date at the top always
            reflects the current version. Continued use after the effective date
            constitutes acceptance.
          </p>
        </Section>

        <Section title="10. Governing law">
          <p>
            These terms are governed by the laws of{' '}
            <span className="rounded bg-amber-950/40 border border-amber-800/60 px-1.5 py-0.5 text-amber-300">
              [TBD — e.g. State of Delaware, USA]
            </span>
            , without regard to its conflict-of-laws principles. Any dispute will be
            brought in the state or federal courts located in that jurisdiction, and
            you consent to personal jurisdiction there.
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            Questions about these terms? Email{' '}
            <a
              className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
              href="mailto:legal@feedsorter.app"
            >
              legal@feedsorter.app
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
