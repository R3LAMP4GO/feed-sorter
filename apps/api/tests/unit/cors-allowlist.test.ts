import { describe, it, expect } from 'vitest';
import { buildAllowlist, resolveOrigin } from '../../src/lib/cors-allowlist.js';

const prod = (extra = '') =>
  buildAllowlist({ appUrl: 'https://app.feedsorter.app', extra, isProd: true });
const dev = (extra = '') =>
  buildAllowlist({ appUrl: 'http://localhost:3000', extra, isProd: false });

describe('buildAllowlist', () => {
  it('always includes APP_URL', () => {
    const a = prod();
    expect(a.exact.has('https://app.feedsorter.app')).toBe(true);
  });

  it('parses comma-separated ALLOWED_ORIGINS', () => {
    const a = prod('https://admin.example.com, https://other.example.com/');
    expect(a.exact.has('https://admin.example.com')).toBe(true);
    // trailing slash is normalized away
    expect(a.exact.has('https://other.example.com')).toBe(true);
    expect(a.exact.has('https://other.example.com/')).toBe(false);
  });

  it('disables extension + localhost passes in prod', () => {
    const a = prod();
    expect(a.allowExtensions).toBe(false);
    expect(a.allowLocalhost).toBe(false);
  });

  it('enables extension + localhost passes in dev', () => {
    const a = dev();
    expect(a.allowExtensions).toBe(true);
    expect(a.allowLocalhost).toBe(true);
  });
});

describe('resolveOrigin', () => {
  it('returns null when Origin is missing (server-to-server)', () => {
    expect(resolveOrigin(prod(), undefined)).toBeNull();
    expect(resolveOrigin(prod(), '')).toBeNull();
  });

  it('echoes exact-match origin', () => {
    const a = prod();
    expect(resolveOrigin(a, 'https://app.feedsorter.app')).toBe('https://app.feedsorter.app');
  });

  it('rejects unknown origin in prod (not "*", not echo)', () => {
    const a = prod();
    expect(resolveOrigin(a, 'https://evil.example.com')).toBeNull();
  });

  it('rejects http://localhost:3000 in prod', () => {
    const a = prod();
    expect(resolveOrigin(a, 'http://localhost:3000')).toBeNull();
  });

  it('accepts http://localhost on any port in dev', () => {
    const a = dev();
    expect(resolveOrigin(a, 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveOrigin(a, 'http://localhost:5173')).toBe('http://localhost:5173');
    expect(resolveOrigin(a, 'http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
  });

  it('rejects https://localhost (we only whitelist http for dev)', () => {
    const a = dev();
    expect(resolveOrigin(a, 'https://localhost:3000')).toBeNull();
  });

  it('accepts a real chrome-extension://<id> in dev', () => {
    const a = dev();
    const id = 'a'.repeat(32);
    expect(resolveOrigin(a, `chrome-extension://${id}`)).toBe(`chrome-extension://${id}`);
  });

  it('rejects chrome-extension://<id> in prod (must be opted in via ALLOWED_ORIGINS)', () => {
    const a = prod();
    const id = 'a'.repeat(32);
    expect(resolveOrigin(a, `chrome-extension://${id}`)).toBeNull();
  });

  it('accepts a chrome-extension://<id> in prod when listed explicitly', () => {
    const id = 'b'.repeat(32);
    const a = prod(`chrome-extension://${id}`);
    expect(resolveOrigin(a, `chrome-extension://${id}`)).toBe(`chrome-extension://${id}`);
  });

  it('rejects malformed extension origins', () => {
    const a = dev();
    expect(resolveOrigin(a, 'chrome-extension://not-32-chars')).toBeNull();
    expect(resolveOrigin(a, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/path')).toBeNull();
  });

  it('does not match a substring of an allowed origin', () => {
    const a = prod();
    // "feedsorter.app" alone must NOT be accepted as a hostname-only echo
    expect(resolveOrigin(a, 'https://app.feedsorter.app.evil.com')).toBeNull();
    expect(resolveOrigin(a, 'https://feedsorter.app')).toBeNull();
  });
});
