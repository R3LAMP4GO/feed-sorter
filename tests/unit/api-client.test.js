import { describe, it, expect, vi } from 'vitest';
import { createApiClient } from '../../src/lib/api-client.js';

function makeFakeFetch() {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, url }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, fetchImpl };
}

describe('api-client', () => {
  it('attaches Authorization Bearer when getToken returns a token', async () => {
    const { calls, fetchImpl } = makeFakeFetch();
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetchImpl,
      getToken: () => 'tok-123',
    });
    await client.me();
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api.test/v1/me',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(calls[0].init.headers.authorization).toBe('Bearer tok-123');
    expect(calls[0].init.credentials).toBe('include');
  });

  it('serializes JSON bodies and sets content-type', async () => {
    const { calls, fetchImpl } = makeFakeFetch();
    const client = createApiClient({ baseUrl: 'http://api.test', fetchImpl });
    await client.requestMagicLink('a@b.co');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
    expect(calls[0].init.body).toBe(JSON.stringify({ email: 'a@b.co' }));
  });

  it('passes FormData bodies through as-is (no JSON wrap)', async () => {
    const { calls, fetchImpl } = makeFakeFetch();
    const client = createApiClient({ baseUrl: 'http://api.test', fetchImpl });
    const file = new File(['hello'], 'a.mp4', { type: 'video/mp4' });
    await client.transcribeFile('yt_abc', file);
    expect(calls[0].init.body).toBeInstanceOf(FormData);
  });

  it('throws on non-2xx with status + body attached', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test', fetchImpl });
    await expect(client.me()).rejects.toMatchObject({
      status: 401,
      body: { error: 'unauthenticated' },
    });
  });

  it('encodes filter+sort as base64url query params', async () => {
    const { calls, fetchImpl } = makeFakeFetch();
    const client = createApiClient({ baseUrl: 'http://api.test', fetchImpl });
    await client.library({
      filter: { and: [{ field: 'platform', op: 'in', value: ['instagram'] }] },
      sort: { by: 'velocity', dir: 'desc' },
      limit: 25,
    });
    const url = calls[0].url;
    expect(url).toContain('/v1/library?');
    expect(url).toContain('filter=');
    expect(url).toContain('sort=');
    expect(url).toContain('limit=25');
  });
});
