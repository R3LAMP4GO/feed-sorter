// Unit tests for POST /v1/posts/sync.
//
// Mounts the route with a fake drizzle handle so the suite verifies the sync
// wire contract without Postgres. Focus: TikTok/YouTube enrichment fields map
// into posts / extractions / transcripts / niche schema.

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stub:stub@127.0.0.1:5432/stub';
  process.env.JWT_SECRET ??= 'stub-secret-32-chars-1234567890ab';
  process.env.NODE_ENV = 'test';
});

import { buildPostsRoutes } from '../../src/routes/posts.js';
import { createSessionToken } from '../../src/auth/jwt.js';

const tableName = (table: unknown): string => {
  for (const sym of Object.getOwnPropertySymbols(table as object)) {
    if (String(sym) === 'Symbol(drizzle:Name)') return String((table as Record<symbol, unknown>)[sym]);
  }
  return 'unknown';
};

interface InsertCall {
  table: string;
  values: Record<string, unknown>;
  conflict?: unknown;
}

interface UpdateCall {
  table: string;
  set: Record<string, unknown>;
}

interface FakeDb {
  calls: {
    inserts: InsertCall[];
    updates: UpdateCall[];
    selects: string[];
  };
  db: unknown;
}

function makeFakeDb(): FakeDb {
  const calls: FakeDb['calls'] = { inserts: [], updates: [], selects: [] };
  let idSeq = 0;

  const selectChain = (_shape: unknown) => ({
    from: (table: unknown) => {
      const name = tableName(table);
      calls.selects.push(name);
      return {
        where: (_where: unknown) => ({
          limit: async () => [],
        }),
      };
    },
  });

  const insertChain = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const call: InsertCall = { table: tableName(table), values };
      calls.inserts.push(call);
      return {
        returning: async () => [{ id: `${call.table}-${++idSeq}` }],
        onConflictDoUpdate: (conflict: unknown) => {
          call.conflict = conflict;
          return Promise.resolve();
        },
        onConflictDoNothing: () => Promise.resolve(),
      };
    },
  });

  const updateChain = (table: unknown) => ({
    set: (set: Record<string, unknown>) => ({
      where: async (_where: unknown) => {
        calls.updates.push({ table: tableName(table), set });
      },
    }),
  });

  return {
    calls,
    db: {
      select: selectChain,
      insert: insertChain,
      update: updateChain,
    },
  };
}

async function authHeader(tier: 'free' | 'pro' | 'studio' = 'pro'): Promise<string> {
  const { token } = await createSessionToken({
    sub: `user-${tier}`,
    email: `${tier}@example.com`,
    tier,
  });
  return `Bearer ${token}`;
}

describe('posts sync route', () => {
  it('persists TikTok enrichment into posts, extractions, transcripts, and niche cluster schema', async () => {
    const fake = makeFakeDb();
    const app = buildPostsRoutes({
      db: fake.db as never,
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    });

    const res = await app.request('/sync', {
      method: 'POST',
      headers: {
        authorization: await authHeader('pro'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        posts: [
          {
            id: 'tt_9001',
            platform: 'tiktok',
            nativeId: '9001',
            scope: 'foryou',
            creator: { platform: 'tiktok', username: 'creator', niche: 'wellness routines' },
            views: 1000,
            likes: 100,
            outlierScore: 3.5,
            velocity: 42,
            caption: 'POV: your morning routine finally sticks',
            coverUrl: 'https://cdn.example.com/cover.jpg',
            durationS: 22,
            niche: 'wellness routines',
            nicheBasis: 'text',
            format: 'pov',
            formatScores: { pov: 0.85 },
            hook: 'Your morning routine finally sticks',
            hookType: 'direct-address',
            middle: 'Shows a repeatable three-step habit stack.',
            cta: 'Follow for simple routines',
            ctaType: 'follow',
            topics: ['Morning Routine', 'habits'],
            transcript: {
              text: 'Your morning routine finally sticks. Follow for simple routines.',
              segments: [{ start: 0, end: 2, text: 'Your morning routine finally sticks.' }],
              source: 'tiktok-captions',
              language: 'en',
              durationS: 22,
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, dropped: 0 });

    const niche = fake.calls.inserts.find((call) => call.table === 'niche_clusters');
    expect(niche?.values).toMatchObject({ label: 'wellness routines' });

    const post = fake.calls.inserts.find((call) => call.table === 'posts');
    expect(post?.values).toMatchObject({
      id: 'tt_9001',
      platform: 'tiktok',
      nativeId: '9001',
      outlierScore: 3.5,
      velocity: 42,
      format: 'pov',
      nicheClusterId: 'niche_clusters-1',
    });
    expect(post?.values.rawMetadata).toEqual({
      nicheBasis: 'text',
      formatScores: { pov: 0.85 },
    });

    const extraction = fake.calls.inserts.find((call) => call.table === 'extractions');
    expect(extraction?.values).toMatchObject({
      postId: 'tt_9001',
      hookText: 'Your morning routine finally sticks',
      hookType: 'direct-address',
      middleSummary: 'Shows a repeatable three-step habit stack.',
      ctaText: 'Follow for simple routines',
      ctaType: 'follow',
      topics: ['morning routine', 'habits'],
      llmModel: 'extension-sync',
    });

    const transcript = fake.calls.inserts.find((call) => call.table === 'transcripts');
    expect(transcript?.values).toMatchObject({
      postId: 'tt_9001',
      fullText: 'Your morning routine finally sticks. Follow for simple routines.',
      source: 'tiktok-captions',
      language: 'en',
      durationS: 22,
    });
    expect(fake.calls.inserts.some((call) => call.table === 'jobs')).toBe(false);
  });

  it('persists YouTube hook, middle, CTA, niche, and format fields', async () => {
    const fake = makeFakeDb();
    const app = buildPostsRoutes({ db: fake.db as never });

    const res = await app.request('/sync', {
      method: 'POST',
      headers: {
        authorization: await authHeader('pro'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        posts: [
          {
            id: 'yt_short123',
            platform: 'youtube',
            nativeId: 'short123',
            scope: 'shorts-feed',
            creator: { platform: 'youtube', username: 'shortscreator' },
            caption: 'How to edit shorts faster — save this workflow',
            views: 5000,
            niche: 'shorts editing',
            format: 'tutorial',
            hook: 'How to edit shorts faster',
            hookType: 'question',
            middleSummary: 'Walks through markers, presets, and export shortcuts.',
            cta: 'Save this workflow',
            ctaType: 'save',
            topics: ['shorts editing', 'workflow'],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, dropped: 0 });

    expect(fake.calls.inserts.find((call) => call.table === 'posts')?.values).toMatchObject({
      id: 'yt_short123',
      platform: 'youtube',
      format: 'tutorial',
      nicheClusterId: 'niche_clusters-1',
    });
    expect(fake.calls.inserts.find((call) => call.table === 'niche_clusters')?.values).toMatchObject({
      label: 'shorts editing',
    });
    expect(fake.calls.inserts.find((call) => call.table === 'extractions')?.values).toMatchObject({
      postId: 'yt_short123',
      hookText: 'How to edit shorts faster',
      hookType: 'question',
      middleSummary: 'Walks through markers, presets, and export shortcuts.',
      ctaText: 'Save this workflow',
      ctaType: 'save',
      topics: ['shorts editing', 'workflow'],
    });
  });

  it('drops gated discovery scopes for free users before any writes', async () => {
    const fake = makeFakeDb();
    const app = buildPostsRoutes({ db: fake.db as never });

    const res = await app.request('/sync', {
      method: 'POST',
      headers: {
        authorization: await authHeader('free'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        posts: [{ id: 'yt_short123', platform: 'youtube', nativeId: 'short123', scope: 'shorts-feed' }],
      }),
    });

    expect(res.status).toBe(402);
    expect(fake.calls.inserts).toHaveLength(0);
  });
});
