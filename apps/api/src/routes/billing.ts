// /v1/billing/* — Stripe Checkout + Customer Portal + webhook.
//
// Webhook signature verification mirrors `solygambas/python-openai-projects`:
//   stripe.webhooks.constructEvent(rawBody, signature, secret).
//
// Three subscription lifecycle events are handled. Tier is resolved from the
// Stripe price's `metadata.tier` (set on the prices created by
// `scripts/stripe-bootstrap.sh` / `stripe/fixtures.json`). When that metadata
// is absent we fall back to matching the price id against the configured
// STRIPE_PRICE_* env vars so existing prices keep working.
//
// `checkout.session.completed`
//   → read `session.metadata.userId` (or `client_reference_id`), look up the
//     subscription, derive tier from the price, set `users.tier` +
//     `users.stripe_customer_id` + `users.current_period_end`.
// `customer.subscription.updated` / `.created`
//   → re-derive tier (handles Pro ↔ Studio up/downgrades) and refresh
//     `current_period_end`. Inactive statuses drop the user back to `free`.
// `customer.subscription.deleted`
//   → set `users.tier = 'free'` and clear `current_period_end`.
//
// All adapters (`stripe`, `userStore`, env) are injected via
// `buildBillingRoutes` so the unit tests can swap them for in-memory fakes
// without standing up Postgres or hitting Stripe (mirrors the DI pattern in
// `routes/llm.ts` and `routes/transcribe.ts`).

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db as defaultDb, type Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { authRequired } from '../auth/middleware.js';
import { stripe as defaultStripe } from '../services/stripe.js';
import { env } from '../env.js';
import { log as defaultLog } from '../log.js';

// -------- Types -------------------------------------------------------------

export type Tier = 'free' | 'pro' | 'studio';

/** Mutable subset of `users` rows touched by the billing flow. */
export interface BillingUpdates {
  tier?: Tier;
  stripeCustomerId?: string;
  currentPeriodEnd?: Date | null;
}

/**
 * Domain-specific seam for the billing handlers. Keeps the route logic
 * decoupled from drizzle so unit tests can pass an in-memory fake.
 */
export interface UserBillingStore {
  findById(
    userId: string,
  ): Promise<{ id: string; email: string; stripeCustomerId: string | null } | null>;
  findByCustomerId(customerId: string): Promise<{ id: string } | null>;
  updateByUserId(userId: string, updates: BillingUpdates): Promise<void>;
  updateByCustomerId(customerId: string, updates: BillingUpdates): Promise<void>;
}

/** Subset of the env we read — narrows the surface for tests. */
export interface BillingEnv {
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_PRO: string;
  STRIPE_PRICE_PRO_FOUNDING: string;
  STRIPE_PRICE_STUDIO: string;
  APP_URL: string;
}

export interface BillingRouteDeps {
  stripe: () => Stripe;
  userStore: UserBillingStore;
  env: BillingEnv;
  log: typeof defaultLog;
}

// -------- Defaults (production wiring) --------------------------------------

function makeDrizzleUserStore(db: Database): UserBillingStore {
  return {
    async findById(userId) {
      const [row] = await db
        .select({ id: users.id, email: users.email, stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row ?? null;
    },
    async findByCustomerId(customerId) {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.stripeCustomerId, customerId))
        .limit(1);
      return row ?? null;
    },
    async updateByUserId(userId, updates) {
      if (Object.keys(updates).length === 0) return;
      await db.update(users).set(updates).where(eq(users.id, userId));
    },
    async updateByCustomerId(customerId, updates) {
      if (Object.keys(updates).length === 0) return;
      await db.update(users).set(updates).where(eq(users.stripeCustomerId, customerId));
    },
  };
}

function resolveDeps(partial: Partial<BillingRouteDeps>): BillingRouteDeps {
  return {
    stripe: partial.stripe ?? defaultStripe,
    userStore: partial.userStore ?? makeDrizzleUserStore(defaultDb),
    log: partial.log ?? defaultLog,
    env: partial.env ?? {
      get STRIPE_WEBHOOK_SECRET() {
        return env.STRIPE_WEBHOOK_SECRET;
      },
      get STRIPE_PRICE_PRO() {
        return env.STRIPE_PRICE_PRO;
      },
      get STRIPE_PRICE_PRO_FOUNDING() {
        return env.STRIPE_PRICE_PRO_FOUNDING;
      },
      get STRIPE_PRICE_STUDIO() {
        return env.STRIPE_PRICE_STUDIO;
      },
      get APP_URL() {
        return env.APP_URL;
      },
    },
  };
}

// -------- Pure helpers ------------------------------------------------------

/** Map a plan key (from a checkout request body) to a configured Stripe price id. */
export function priceIdForPlan(plan: string, e: BillingEnv): string | null {
  switch (plan) {
    case 'pro':
      return e.STRIPE_PRICE_PRO || null;
    case 'pro-founding':
      return e.STRIPE_PRICE_PRO_FOUNDING || null;
    case 'studio':
      return e.STRIPE_PRICE_STUDIO || null;
    default:
      return null;
  }
}

/**
 * Resolve the tier for a Stripe price object.
 *
 *  1. Prefer `price.metadata.tier` — that's what the bootstrap script + the
 *     fixtures.json set, so this works without any extra env wiring.
 *  2. Fall back to matching `price.id` against the configured STRIPE_PRICE_*
 *     env vars so older prices (no metadata) still resolve.
 *  3. Return `null` when nothing matches — callers should treat that as
 *     "leave the tier as-is" rather than silently downgrading.
 */
export function tierFromPrice(
  price: Pick<Stripe.Price, 'id' | 'metadata'> | null | undefined,
  e: BillingEnv,
): Tier | null {
  if (!price) return null;
  const meta = price.metadata?.tier;
  if (meta === 'pro' || meta === 'studio') return meta;
  if (price.id && price.id === e.STRIPE_PRICE_PRO) return 'pro';
  if (price.id && price.id === e.STRIPE_PRICE_PRO_FOUNDING) return 'pro';
  if (price.id && price.id === e.STRIPE_PRICE_STUDIO) return 'studio';
  return null;
}

function unixToDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

function isActiveStatus(status: Stripe.Subscription.Status): boolean {
  return status === 'active' || status === 'trialing';
}

/**
 * Extract the (first) price from a subscription's items. Stripe webhook
 * payloads embed the full price object by default, but we handle both
 * shapes — `string` (just id) and `Stripe.Price` — for robustness.
 *
 * When only the id is present, we fetch the full price so we can read its
 * metadata.
 */
async function readSubscriptionPrice(
  subscription: Stripe.Subscription,
  stripeClient: Stripe,
): Promise<Stripe.Price | null> {
  const item = subscription.items?.data?.[0];
  if (!item) return null;
  const price = item.price;
  if (!price) return null;
  if (typeof price === 'string') {
    return stripeClient.prices.retrieve(price);
  }
  // The embedded price object may already carry metadata; if it doesn't,
  // we still return it — `tierFromPrice` falls back to id-matching.
  return price;
}

// -------- Webhook dispatch --------------------------------------------------

/**
 * Apply a Stripe webhook event to the user store. Exported so unit tests can
 * exercise each event type directly without going through HTTP.
 *
 * Returns the `Tier` decision that was applied (or `null` when the event
 * was ignored / the tier could not be derived).
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  deps: BillingRouteDeps,
): Promise<Tier | null> {
  const { stripe, userStore, env: e, log } = deps;
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId =
        typeof session.customer === 'string'
          ? session.customer
          : (session.customer?.id ?? null);
      // Prefer metadata.userId (per task spec), then client_reference_id, then
      // look up the user by stripe_customer_id from a prior /checkout call.
      let userId: string | null =
        session.metadata?.userId ?? session.client_reference_id ?? null;
      if (!userId && customerId) {
        const row = await userStore.findByCustomerId(customerId);
        userId = row?.id ?? null;
      }
      if (!userId) {
        log.warn({ sessionId: session.id }, 'checkout.session.completed: no user');
        return null;
      }

      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription?.id ?? null);
      if (!subscriptionId) {
        log.warn({ sessionId: session.id }, 'checkout.session.completed: no subscription');
        return null;
      }

      const subscription = await stripe().subscriptions.retrieve(subscriptionId);
      const price = await readSubscriptionPrice(subscription, stripe());
      const tier = tierFromPrice(price, e);
      if (!tier) {
        log.warn(
          { sessionId: session.id, priceId: price?.id },
          'checkout.session.completed: unknown tier',
        );
        return null;
      }

      const updates: BillingUpdates = {
        tier,
        currentPeriodEnd: unixToDate(subscription.current_period_end),
      };
      if (customerId) updates.stripeCustomerId = customerId;

      await userStore.updateByUserId(userId, updates);
      return tier;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;
      if (!customerId) return null;

      // Inactive statuses → drop to free. The user can still be re-promoted
      // by a later `updated` once payment recovers.
      if (!isActiveStatus(subscription.status)) {
        await userStore.updateByCustomerId(customerId, {
          tier: 'free',
          currentPeriodEnd: null,
        });
        return 'free';
      }

      const price = await readSubscriptionPrice(subscription, stripe());
      // If the embedded price lacked metadata, retrieve the full record so we
      // can resolve tier from metadata before falling back to env matching.
      let resolved: Tier | null = tierFromPrice(price, e);
      if (!resolved && price?.id) {
        const fetched = await stripe().prices.retrieve(price.id);
        resolved = tierFromPrice(fetched, e);
      }
      if (!resolved) {
        log.warn(
          { subscriptionId: subscription.id, priceId: price?.id },
          'subscription.updated: unknown tier',
        );
        return null;
      }
      await userStore.updateByCustomerId(customerId, {
        tier: resolved,
        currentPeriodEnd: unixToDate(subscription.current_period_end),
      });
      return resolved;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;
      if (!customerId) return null;
      await userStore.updateByCustomerId(customerId, {
        tier: 'free',
        currentPeriodEnd: null,
      });
      return 'free';
    }

    default:
      log.debug({ type: event.type }, 'stripe event ignored');
      return null;
  }
}

// -------- Routes ------------------------------------------------------------

export function buildBillingRoutes(partial: Partial<BillingRouteDeps> = {}): Hono {
  const deps = resolveDeps(partial);
  const app = new Hono();

  // POST /v1/billing/checkout  { plan?: 'pro' | 'pro-founding' | 'studio' }
  // Returns the Checkout Session URL for the requested plan.
  app.post('/checkout', authRequired, async (c) => {
    const user = c.get('user')!;
    const body = (await c.req.json().catch(() => ({}))) as { plan?: string };
    const plan = body?.plan === 'studio'
      ? 'studio'
      : body?.plan === 'pro-founding'
        ? 'pro-founding'
        : 'pro';
    const priceId = priceIdForPlan(plan, deps.env);
    if (!priceId) return c.json({ error: 'plan-not-configured', plan }, 500);

    const row = await deps.userStore.findById(user.sub);
    if (!row) return c.json({ error: 'user-not-found' }, 404);

    let customerId = row.stripeCustomerId;
    if (!customerId) {
      const customer = await deps.stripe().customers.create({
        email: row.email,
        metadata: { userId: row.id },
      });
      customerId = customer.id;
      await deps.userStore.updateByUserId(row.id, { stripeCustomerId: customerId });
    }

    const session = await deps.stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Set BOTH session-level and subscription-level metadata so the webhook
      // handler can read `session.metadata.userId` (preferred path per
      // canonical webhook flow) AND the subscription itself carries the
      // userId for any future audit / debugging.
      metadata: { userId: row.id, plan },
      subscription_data: {
        trial_period_days: 7,
        metadata: { userId: row.id, plan },
      },
      success_url: `${deps.env.APP_URL}/billing?status=success`,
      cancel_url: `${deps.env.APP_URL}/billing?status=cancelled`,
      allow_promotion_codes: true,
      client_reference_id: row.id,
    });

    return c.json({ url: session.url });
  });

  // POST /v1/billing/portal — Customer Portal session
  app.post('/portal', authRequired, async (c) => {
    const user = c.get('user')!;
    const row = await deps.userStore.findById(user.sub);
    if (!row?.stripeCustomerId) return c.json({ error: 'no-customer' }, 400);
    const session = await deps.stripe().billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: `${deps.env.APP_URL}/billing`,
    });
    return c.json({ url: session.url });
  });

  // POST /v1/billing/webhook — raw body required for signature verify.
  app.post('/webhook', async (c) => {
    if (!deps.env.STRIPE_WEBHOOK_SECRET) {
      return c.json({ error: 'webhook-not-configured' }, 500);
    }
    const sig = c.req.header('stripe-signature') ?? '';
    const body = await c.req.text();

    let event: Stripe.Event;
    try {
      event = deps.stripe().webhooks.constructEvent(body, sig, deps.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'invalid stripe signature');
      return c.json({ error: 'invalid-signature' }, 400);
    }

    try {
      await handleStripeEvent(event, deps);
    } catch (err) {
      deps.log.error(
        { err: (err as Error).message, type: event.type },
        'stripe handler failed',
      );
      return c.json({ error: 'handler-failed' }, 500);
    }
    return c.json({ received: true });
  });

  return app;
}

// Default export wires up the production adapters — real stripe SDK +
// drizzle-backed user store + real env.
export default buildBillingRoutes();
