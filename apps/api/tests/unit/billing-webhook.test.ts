// Unit tests for the /v1/billing/* webhook handler.
//
// We mount `buildBillingRoutes` against fully in-memory fakes for the
// Stripe SDK and the user store so the suite stays hermetic — no Postgres,
// no network. Pattern mirrors `tests/unit/llm-routes.test.ts` (Hono app +
// injectable deps) and `tests/unit/cache.test.ts` (storage seam fakes).
//
// Three subscription lifecycle events are exercised against the same set
// of fixtures:
//
//   1. `checkout.session.completed`           → tier flips free → pro / studio
//   2. `customer.subscription.updated`        → Pro ↔ Studio up/downgrades
//   3. `customer.subscription.deleted`        → tier reverts to free
//
// Plus edge cases: inactive subscription status, missing user lookup,
// invalid webhook signature.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';

// env.ts reads `DATABASE_URL` / `JWT_SECRET` lazily, but `db/client.ts` and
// `services/stripe.ts` resolve them at module-load time. Stub before any
// import that pulls those in. `vi.hoisted` lifts this above ESM import
// hoisting so the env is set before billing.ts's default export runs
// `buildBillingRoutes()` at module load.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stub:stub@127.0.0.1:5432/stub';
  process.env.JWT_SECRET ??= 'stub-secret-32-chars-1234567890ab';
  process.env.NODE_ENV = 'test';
  // Configure the price ids so `tierFromPrice` can fall back to env matching
  // when a webhook event doesn't carry metadata.
  process.env.STRIPE_PRICE_PRO = 'price_pro_19';
  process.env.STRIPE_PRICE_PRO_FOUNDING = 'price_pro_founding_19';
  process.env.STRIPE_PRICE_STUDIO = 'price_studio_49';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_stub';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
});

import {
  buildBillingRoutes,
  handleStripeEvent,
  priceIdForPlan,
  tierFromPrice,
  type BillingEnv,
  type BillingRouteDeps,
  type BillingUpdates,
  type Tier,
  type UserBillingStore,
} from '../../src/routes/billing.js';

// -------- Fakes -------------------------------------------------------------

interface FakeUserRow {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  tier: Tier;
  currentPeriodEnd: Date | null;
}

interface FakeUserStore extends UserBillingStore {
  rows: Map<string, FakeUserRow>;
  calls: {
    findById: number;
    findByCustomerId: number;
    updateByUserId: number;
    updateByCustomerId: number;
  };
  seed: (row: FakeUserRow) => void;
  /** Read a row by user id (test helper, bypasses the store contract). */
  get: (userId: string) => FakeUserRow | undefined;
}

function makeFakeUserStore(): FakeUserStore {
  const rows = new Map<string, FakeUserRow>();
  const calls = {
    findById: 0,
    findByCustomerId: 0,
    updateByUserId: 0,
    updateByCustomerId: 0,
  };
  function findByCustomerIdSync(customerId: string): FakeUserRow | undefined {
    for (const row of rows.values()) {
      if (row.stripeCustomerId === customerId) return row;
    }
    return undefined;
  }
  return {
    rows,
    calls,
    seed(row) {
      rows.set(row.id, { ...row });
    },
    get(userId) {
      const r = rows.get(userId);
      return r ? { ...r } : undefined;
    },
    async findById(userId) {
      calls.findById += 1;
      const row = rows.get(userId);
      if (!row) return null;
      return { id: row.id, email: row.email, stripeCustomerId: row.stripeCustomerId };
    },
    async findByCustomerId(customerId) {
      calls.findByCustomerId += 1;
      const row = findByCustomerIdSync(customerId);
      return row ? { id: row.id } : null;
    },
    async updateByUserId(userId, updates) {
      calls.updateByUserId += 1;
      const row = rows.get(userId);
      if (!row) return;
      applyUpdates(row, updates);
    },
    async updateByCustomerId(customerId, updates) {
      calls.updateByCustomerId += 1;
      const row = findByCustomerIdSync(customerId);
      if (!row) return;
      applyUpdates(row, updates);
    },
  };
}

function applyUpdates(row: FakeUserRow, updates: BillingUpdates): void {
  if (updates.tier !== undefined) row.tier = updates.tier;
  if (updates.stripeCustomerId !== undefined) row.stripeCustomerId = updates.stripeCustomerId;
  if (updates.currentPeriodEnd !== undefined) row.currentPeriodEnd = updates.currentPeriodEnd;
}

interface FakeStripe {
  client: {
    subscriptions: {
      retrieve: ReturnType<typeof vi.fn>;
    };
    prices: {
      retrieve: ReturnType<typeof vi.fn>;
    };
    customers: {
      create: ReturnType<typeof vi.fn>;
    };
    checkout: {
      sessions: {
        create: ReturnType<typeof vi.fn>;
      };
    };
    billingPortal: {
      sessions: {
        create: ReturnType<typeof vi.fn>;
      };
    };
    webhooks: {
      constructEvent: ReturnType<typeof vi.fn>;
    };
  };
  seedSubscription: (sub: PartialSubscription) => void;
  seedPrice: (price: { id: string; metadata?: Record<string, string> }) => void;
}

interface PartialSubscription {
  id: string;
  status?: Stripe.Subscription.Status;
  customer: string;
  current_period_end?: number;
  items: { data: Array<{ price: { id: string; metadata?: Record<string, string> } | string }> };
}

function makeFakeStripe(): FakeStripe {
  const subscriptions = new Map<string, PartialSubscription>();
  const prices = new Map<string, { id: string; metadata?: Record<string, string> }>();

  const client = {
    subscriptions: {
      retrieve: vi.fn(async (id: string) => {
        const sub = subscriptions.get(id);
        if (!sub) throw new Error(`fake-stripe: unknown subscription ${id}`);
        return sub as unknown as Stripe.Subscription;
      }),
    },
    prices: {
      retrieve: vi.fn(async (id: string) => {
        const price = prices.get(id);
        if (!price) throw new Error(`fake-stripe: unknown price ${id}`);
        return { ...price, metadata: { ...(price.metadata ?? {}) } } as unknown as Stripe.Price;
      }),
    },
    customers: {
      create: vi.fn(async (params: { email?: string; metadata?: Record<string, string> }) => ({
        id: `cus_${Math.random().toString(36).slice(2, 10)}`,
        email: params.email ?? null,
        metadata: params.metadata ?? {},
      })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (params: Record<string, unknown>) => ({
          id: 'cs_test_stub',
          url: 'https://checkout.stripe.com/c/pay/cs_test_stub',
          ...params,
        })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async (_params: Record<string, unknown>) => ({
          id: 'bps_test_stub',
          url: 'https://billing.stripe.com/p/session/bps_test_stub',
        })),
      },
    },
    webhooks: {
      // In tests we trust the body — just JSON.parse it. Production goes
      // through `stripe.webhooks.constructEvent` which verifies the signature.
      constructEvent: vi.fn((body: string, sig: string, _secret: string) => {
        if (sig === 'invalid') {
          throw new Error('No signatures found matching the expected signature for payload');
        }
        return JSON.parse(body) as Stripe.Event;
      }),
    },
  };
  return {
    client,
    seedSubscription(sub) {
      subscriptions.set(sub.id, sub);
    },
    seedPrice(price) {
      prices.set(price.id, price);
    },
  };
}

// -------- Test env / deps --------------------------------------------------

const TEST_ENV: BillingEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_test_stub',
  STRIPE_PRICE_PRO: 'price_pro_19',
  STRIPE_PRICE_PRO_FOUNDING: 'price_pro_founding_19',
  STRIPE_PRICE_STUDIO: 'price_studio_49',
  APP_URL: 'http://localhost:3000',
};

function makeDeps(overrides: Partial<BillingRouteDeps> = {}): {
  deps: BillingRouteDeps;
  store: FakeUserStore;
  stripe: FakeStripe;
} {
  const store = makeFakeUserStore();
  const stripe = makeFakeStripe();
  const deps: BillingRouteDeps = {
    stripe: () => stripe.client as unknown as Stripe,
    userStore: store,
    env: TEST_ENV,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    ...overrides,
  };
  return { deps, store, stripe };
}

// -------- Fixture builders --------------------------------------------------

interface CheckoutFixtureOpts {
  userId?: string;
  customerId?: string;
  subscriptionId?: string;
  /** Also set `client_reference_id` (back-compat path). */
  setClientReference?: boolean;
}

function checkoutSessionEvent(opts: CheckoutFixtureOpts = {}): Stripe.Event {
  const userId = opts.userId ?? 'user-1';
  const customerId = opts.customerId ?? 'cus_test_1';
  const subscriptionId = opts.subscriptionId ?? 'sub_test_1';
  const session: Partial<Stripe.Checkout.Session> = {
    id: 'cs_test_stub',
    object: 'checkout.session',
    customer: customerId,
    subscription: subscriptionId,
    metadata: { userId },
    client_reference_id: opts.setClientReference ? userId : null,
  };
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: session as Stripe.Checkout.Session },
    livemode: false,
    api_version: '2024-09-30.acacia',
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    created: Math.floor(Date.now() / 1000),
  } as unknown as Stripe.Event;
}

function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted',
  opts: {
    id?: string;
    customerId?: string;
    status?: Stripe.Subscription.Status;
    priceId?: string;
    priceMetadataTier?: 'pro' | 'studio' | null;
    /** When set, the embedded items[0].price is just a string (no expansion). */
    priceAsId?: boolean;
    currentPeriodEnd?: number;
  } = {},
): Stripe.Event {
  const priceId = opts.priceId ?? 'price_pro_19';
  const metadata: Record<string, string> =
    opts.priceMetadataTier === null
      ? {}
      : { tier: opts.priceMetadataTier ?? 'pro' };
  const embeddedPrice = opts.priceAsId
    ? priceId
    : { id: priceId, metadata };
  const sub = {
    id: opts.id ?? 'sub_test_1',
    object: 'subscription',
    status: opts.status ?? 'active',
    customer: opts.customerId ?? 'cus_test_1',
    current_period_end: opts.currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    items: { data: [{ price: embeddedPrice }] },
  };
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    type,
    data: { object: sub as unknown as Stripe.Subscription },
    livemode: false,
    api_version: '2024-09-30.acacia',
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    created: Math.floor(Date.now() / 1000),
  } as unknown as Stripe.Event;
}

// -------- Tests ------------------------------------------------------------

describe('billing pure helpers', () => {
  describe('priceIdForPlan', () => {
    it('maps each plan key to the configured price id', () => {
      expect(priceIdForPlan('pro', TEST_ENV)).toBe('price_pro_19');
      expect(priceIdForPlan('pro-founding', TEST_ENV)).toBe('price_pro_founding_19');
      expect(priceIdForPlan('studio', TEST_ENV)).toBe('price_studio_49');
    });

    it('returns null for unknown plans', () => {
      expect(priceIdForPlan('enterprise', TEST_ENV)).toBeNull();
      expect(priceIdForPlan('', TEST_ENV)).toBeNull();
    });

    it('returns null when the corresponding env var is empty', () => {
      const empty: BillingEnv = { ...TEST_ENV, STRIPE_PRICE_STUDIO: '' };
      expect(priceIdForPlan('studio', empty)).toBeNull();
      expect(priceIdForPlan('pro', empty)).toBe('price_pro_19');
    });
  });

  describe('tierFromPrice', () => {
    it('reads price.metadata.tier first', () => {
      expect(
        tierFromPrice({ id: 'whatever', metadata: { tier: 'pro' } }, TEST_ENV),
      ).toBe('pro');
      expect(
        tierFromPrice({ id: 'whatever', metadata: { tier: 'studio' } }, TEST_ENV),
      ).toBe('studio');
    });

    it('falls back to matching the price id against env when metadata is absent', () => {
      expect(tierFromPrice({ id: 'price_pro_19', metadata: {} }, TEST_ENV)).toBe('pro');
      expect(
        tierFromPrice({ id: 'price_pro_founding_19', metadata: {} }, TEST_ENV),
      ).toBe('pro');
      expect(tierFromPrice({ id: 'price_studio_49', metadata: {} }, TEST_ENV)).toBe(
        'studio',
      );
    });

    it('returns null for unknown prices with no metadata', () => {
      expect(tierFromPrice({ id: 'price_unknown', metadata: {} }, TEST_ENV)).toBeNull();
      expect(tierFromPrice(null, TEST_ENV)).toBeNull();
    });

    it('ignores garbage tier metadata values', () => {
      expect(
        tierFromPrice({ id: 'price_unknown', metadata: { tier: 'enterprise' } }, TEST_ENV),
      ).toBeNull();
    });
  });
});

describe('handleStripeEvent', () => {
  describe('checkout.session.completed', () => {
    it('flips a free user to pro using session.metadata.userId + price metadata', async () => {
      const { deps, store, stripe } = makeDeps();
      store.seed({
        id: 'user-1',
        email: 'pro@example.com',
        stripeCustomerId: null,
        tier: 'free',
        currentPeriodEnd: null,
      });
      stripe.seedSubscription({
        id: 'sub_test_1',
        customer: 'cus_test_1',
        status: 'active',
        current_period_end: 1_800_000_000,
        items: { data: [{ price: { id: 'price_pro_19', metadata: { tier: 'pro' } } }] },
      });

      const tier = await handleStripeEvent(
        checkoutSessionEvent({
          userId: 'user-1',
          customerId: 'cus_test_1',
          subscriptionId: 'sub_test_1',
        }),
        deps,
      );

      expect(tier).toBe('pro');
      const row = store.get('user-1');
      expect(row?.tier).toBe('pro');
      expect(row?.stripeCustomerId).toBe('cus_test_1');
      expect(row?.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));
      expect(store.calls.updateByUserId).toBe(1);
    });

    it('flips a free user to studio when the price metadata says studio', async () => {
      const { deps, store, stripe } = makeDeps();
      store.seed({
        id: 'user-2',
        email: 'studio@example.com',
        stripeCustomerId: null,
        tier: 'free',
        currentPeriodEnd: null,
      });
      stripe.seedSubscription({
        id: 'sub_test_2',
        customer: 'cus_test_2',
        status: 'active',
        current_period_end: 1_800_000_000,
        items: { data: [{ price: { id: 'price_studio_49', metadata: { tier: 'studio' } } }] },
      });

      const tier = await handleStripeEvent(
        checkoutSessionEvent({
          userId: 'user-2',
          customerId: 'cus_test_2',
          subscriptionId: 'sub_test_2',
        }),
        deps,
      );

      expect(tier).toBe('studio');
      expect(store.get('user-2')?.tier).toBe('studio');
      expect(store.get('user-2')?.stripeCustomerId).toBe('cus_test_2');
    });

    it('falls back to client_reference_id when metadata.userId is missing', async () => {
      const { deps, store, stripe } = makeDeps();
      store.seed({
        id: 'user-3',
        email: 'crf@example.com',
        stripeCustomerId: null,
        tier: 'free',
        currentPeriodEnd: null,
      });
      stripe.seedSubscription({
        id: 'sub_test_3',
        customer: 'cus_test_3',
        status: 'active',
        current_period_end: 1_800_000_000,
        items: { data: [{ price: { id: 'price_pro_19', metadata: { tier: 'pro' } } }] },
      });

      const event = checkoutSessionEvent({
        userId: 'user-3',
        customerId: 'cus_test_3',
        subscriptionId: 'sub_test_3',
        setClientReference: true,
      });
      // Strip metadata.userId — only client_reference_id remains.
      (event.data.object as Stripe.Checkout.Session).metadata = null;

      const tier = await handleStripeEvent(event, deps);
      expect(tier).toBe('pro');
      expect(store.get('user-3')?.tier).toBe('pro');
    });

    it('falls back to looking up the user by stripe_customer_id', async () => {
      const { deps, store, stripe } = makeDeps();
      store.seed({
        id: 'user-4',
        email: 'pre-bound@example.com',
        stripeCustomerId: 'cus_existing',
        tier: 'free',
        currentPeriodEnd: null,
      });
      stripe.seedSubscription({
        id: 'sub_test_4',
        customer: 'cus_existing',
        status: 'active',
        current_period_end: 1_800_000_000,
        items: { data: [{ price: { id: 'price_pro_19', metadata: { tier: 'pro' } } }] },
      });

      const event = checkoutSessionEvent({
        userId: 'user-4',
        customerId: 'cus_existing',
        subscriptionId: 'sub_test_4',
      });
      // Wipe BOTH userId hints — handler must reach for the customer lookup.
      (event.data.object as Stripe.Checkout.Session).metadata = null;
      (event.data.object as Stripe.Checkout.Session).client_reference_id = null;

      const tier = await handleStripeEvent(event, deps);
      expect(tier).toBe('pro');
      expect(store.get('user-4')?.tier).toBe('pro');
      expect(store.calls.findByCustomerId).toBe(1);
    });

    it('returns null and writes nothing when the user cannot be identified', async () => {
      const { deps, store } = makeDeps();
      const event = checkoutSessionEvent();
      (event.data.object as Stripe.Checkout.Session).metadata = null;
      (event.data.object as Stripe.Checkout.Session).client_reference_id = null;
      (event.data.object as Stripe.Checkout.Session).customer = null;

      const tier = await handleStripeEvent(event, deps);
      expect(tier).toBeNull();
      expect(store.calls.updateByUserId).toBe(0);
      expect(store.calls.updateByCustomerId).toBe(0);
    });

    it('returns null when the price metadata is unknown and id matches nothing', async () => {
      const { deps, store, stripe } = makeDeps();
      store.seed({
        id: 'user-x',
        email: 'x@example.com',
        stripeCustomerId: null,
        tier: 'free',
        currentPeriodEnd: null,
      });
      stripe.seedSubscription({
        id: 'sub_x',
        customer: 'cus_x',
        status: 'active',
        items: {
          data: [{ price: { id: 'price_other', metadata: { tier: 'enterprise' } } }],
        },
      });

      const tier = await handleStripeEvent(
        checkoutSessionEvent({
          userId: 'user-x',
          customerId: 'cus_x',
          subscriptionId: 'sub_x',
        }),
        deps,
      );
      expect(tier).toBeNull();
      expect(store.get('user-x')?.tier).toBe('free');
    });
  });

  describe('customer.subscription.updated', () => {
    it('upgrades a pro user to studio when the price metadata flips', async () => {
      const { deps, store } = makeDeps();
      store.seed({
        id: 'user-up',
        email: 'up@example.com',
        stripeCustomerId: 'cus_up',
        tier: 'pro',
        currentPeriodEnd: new Date(1_700_000_000_000),
      });

      const tier = await handleStripeEvent(
        subscriptionEvent('customer.subscription.updated', {
          customerId: 'cus_up',
          status: 'active',
          priceId: 'price_studio_49',
          priceMetadataTier: 'studio',
          currentPeriodEnd: 1_900_000_000,
        }),
        deps,
      );

      expect(tier).toBe('studio');
      const row = store.get('user-up');
      expect(row?.tier).toBe('studio');
      expect(row?.currentPeriodEnd).toEqual(new Date(1_900_000_000 * 1000));
      expect(store.calls.updateByCustomerId).toBe(1);
    });

    it('downgrades a studio user to pro when the price flips back', async () => {
      const { deps, store } = makeDeps();
      store.seed({
        id: 'user-down',
        email: 'down@example.com',
        stripeCustomerId: 'cus_down',
        tier: 'studio',
        currentPeriodEnd: new Date(1_700_000_000_000),
      });

      const tier = await handleStripeEvent(
        subscriptionEvent('customer.subscription.updated', {
          customerId: 'cus_down',
          status: 'active',
          priceId: 'price_pro_19',
          priceMetadataTier: 'pro',
        }),
        deps,
      );

      expect(tier).toBe('pro');
      expect(store.get('user-down')?.tier).toBe('pro');
    });

    it('keeps the active tier through `created` events too', async () => {
      const { deps, store } = makeDeps();
      store.seed({
        id: 'user-created',
        email: 'created@example.com',
        stripeCustomerId: 'cus_created',
        tier: 'free',
        currentPeriodEnd: null,
      });
      const tier = await handleStripeEvent(
        subscriptionEvent('customer.subscription.created', {
          customerId: 'cus_created',
          status: 'active',
          priceMetadataTier: 'pro',
        }),
        deps,
      );
      expect(tier).toBe('pro');
      expect(store.get('user-created')?.tier).toBe('pro');
    });

    it('retrieves the full price when the embedded item is just the id', async () => {
      const { deps, store, stripe } = makeDeps();
      store.seed({
        id: 'user-fetch',
        email: 'fetch@example.com',
        stripeCustomerId: 'cus_fetch',
        tier: 'free',
        currentPeriodEnd: null,
      });
      // Seed a price record so the fallback `prices.retrieve` lookup succeeds.
      stripe.seedPrice({ id: 'price_studio_49', metadata: { tier: 'studio' } });

      const tier = await handleStripeEvent(
        subscriptionEvent('customer.subscription.updated', {
          customerId: 'cus_fetch',
          status: 'active',
          priceId: 'price_studio_49',
          priceAsId: true,
        }),
        deps,
      );

      expect(tier).toBe('studio');
      expect(store.get('user-fetch')?.tier).toBe('studio');
      // One retrieve to fetch the full price, since the item only had an id.
      expect(stripe.client.prices.retrieve).toHaveBeenCalledWith('price_studio_49');
    });

    it('drops the user back to free when the subscription enters past_due', async () => {
      const { deps, store } = makeDeps();
      store.seed({
        id: 'user-pd',
        email: 'pd@example.com',
        stripeCustomerId: 'cus_pd',
        tier: 'pro',
        currentPeriodEnd: new Date(1_700_000_000_000),
      });

      const tier = await handleStripeEvent(
        subscriptionEvent('customer.subscription.updated', {
          customerId: 'cus_pd',
          status: 'past_due',
        }),
        deps,
      );

      expect(tier).toBe('free');
      expect(store.get('user-pd')?.tier).toBe('free');
      expect(store.get('user-pd')?.currentPeriodEnd).toBeNull();
    });
  });

  describe('customer.subscription.deleted', () => {
    it('reverts a pro user to free and clears the period end', async () => {
      const { deps, store } = makeDeps();
      store.seed({
        id: 'user-del',
        email: 'del@example.com',
        stripeCustomerId: 'cus_del',
        tier: 'pro',
        currentPeriodEnd: new Date(1_700_000_000_000),
      });

      const tier = await handleStripeEvent(
        subscriptionEvent('customer.subscription.deleted', {
          customerId: 'cus_del',
          status: 'canceled',
        }),
        deps,
      );

      expect(tier).toBe('free');
      const row = store.get('user-del');
      expect(row?.tier).toBe('free');
      expect(row?.currentPeriodEnd).toBeNull();
      expect(store.calls.updateByCustomerId).toBe(1);
    });

    it('reverts a studio user to free', async () => {
      const { deps, store } = makeDeps();
      store.seed({
        id: 'user-del2',
        email: 'del2@example.com',
        stripeCustomerId: 'cus_del2',
        tier: 'studio',
        currentPeriodEnd: new Date(1_700_000_000_000),
      });

      await handleStripeEvent(
        subscriptionEvent('customer.subscription.deleted', {
          customerId: 'cus_del2',
        }),
        deps,
      );

      expect(store.get('user-del2')?.tier).toBe('free');
    });
  });

  describe('unrelated events', () => {
    it('ignores event types it does not handle', async () => {
      const { deps, store } = makeDeps();
      const evt = {
        id: 'evt_other',
        object: 'event',
        type: 'invoice.payment_succeeded',
        data: { object: {} },
        livemode: false,
        api_version: '2024-09-30.acacia',
        pending_webhooks: 0,
        request: { id: null, idempotency_key: null },
        created: Math.floor(Date.now() / 1000),
      } as unknown as Stripe.Event;

      const tier = await handleStripeEvent(evt, deps);
      expect(tier).toBeNull();
      expect(store.calls.updateByUserId).toBe(0);
      expect(store.calls.updateByCustomerId).toBe(0);
    });
  });
});

describe('POST /v1/billing/webhook', () => {
  beforeEach(() => {
    process.env.DEV_FORCE_TIER = undefined;
    process.env.NODE_ENV = 'test';
  });

  it('end-to-end: signed checkout event flips tier to pro', async () => {
    const { deps, store, stripe } = makeDeps();
    store.seed({
      id: 'user-e2e',
      email: 'e2e@example.com',
      stripeCustomerId: null,
      tier: 'free',
      currentPeriodEnd: null,
    });
    stripe.seedSubscription({
      id: 'sub_e2e',
      customer: 'cus_e2e',
      status: 'active',
      current_period_end: 1_800_000_000,
      items: { data: [{ price: { id: 'price_pro_19', metadata: { tier: 'pro' } } }] },
    });

    const app = buildBillingRoutes(deps);
    const event = checkoutSessionEvent({
      userId: 'user-e2e',
      customerId: 'cus_e2e',
      subscriptionId: 'sub_e2e',
    });

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid-stub',
      },
      body: JSON.stringify(event),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(store.get('user-e2e')?.tier).toBe('pro');
  });

  it('returns 400 when the signature is invalid', async () => {
    const { deps, store } = makeDeps();
    store.seed({
      id: 'user-bad',
      email: 'bad@example.com',
      stripeCustomerId: 'cus_bad',
      tier: 'pro',
      currentPeriodEnd: null,
    });
    const app = buildBillingRoutes(deps);

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'invalid',
      },
      body: JSON.stringify(checkoutSessionEvent({ userId: 'user-bad' })),
    });

    expect(res.status).toBe(400);
    // Tier untouched.
    expect(store.get('user-bad')?.tier).toBe('pro');
  });

  it('returns 500 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    const { deps } = makeDeps({
      env: { ...TEST_ENV, STRIPE_WEBHOOK_SECRET: '' },
    });
    const app = buildBillingRoutes(deps);
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'whatever' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'webhook-not-configured',
    });
  });

  it('end-to-end: subscription.updated upgrades pro → studio', async () => {
    const { deps, store } = makeDeps();
    store.seed({
      id: 'user-up-e2e',
      email: 'up-e2e@example.com',
      stripeCustomerId: 'cus_up_e2e',
      tier: 'pro',
      currentPeriodEnd: new Date(1_700_000_000_000),
    });
    const app = buildBillingRoutes(deps);

    const event = subscriptionEvent('customer.subscription.updated', {
      customerId: 'cus_up_e2e',
      status: 'active',
      priceId: 'price_studio_49',
      priceMetadataTier: 'studio',
      currentPeriodEnd: 1_900_000_000,
    });

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid-stub',
      },
      body: JSON.stringify(event),
    });

    expect(res.status).toBe(200);
    expect(store.get('user-up-e2e')?.tier).toBe('studio');
    expect(store.get('user-up-e2e')?.currentPeriodEnd).toEqual(
      new Date(1_900_000_000 * 1000),
    );
  });

  it('end-to-end: subscription.deleted reverts studio → free', async () => {
    const { deps, store } = makeDeps();
    store.seed({
      id: 'user-del-e2e',
      email: 'del-e2e@example.com',
      stripeCustomerId: 'cus_del_e2e',
      tier: 'studio',
      currentPeriodEnd: new Date(1_700_000_000_000),
    });
    const app = buildBillingRoutes(deps);

    const event = subscriptionEvent('customer.subscription.deleted', {
      customerId: 'cus_del_e2e',
      status: 'canceled',
    });

    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'valid-stub',
      },
      body: JSON.stringify(event),
    });

    expect(res.status).toBe(200);
    expect(store.get('user-del-e2e')?.tier).toBe('free');
    expect(store.get('user-del-e2e')?.currentPeriodEnd).toBeNull();
  });
});
