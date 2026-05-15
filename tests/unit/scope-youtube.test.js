import { describe, it, expect } from 'vitest';
import { deriveScope } from '../../src/lib/scope-youtube.js';

describe('scope-youtube', () => {
  it('classifies /shorts/<id> as shorts-feed', () => {
    expect(deriveScope('/shorts/abc123XYZ_-')).toEqual({
      kind: 'shorts-feed',
      username: null,
      videoId: 'abc123XYZ_-',
    });
  });

  it('classifies /feed/shorts as shorts-feed', () => {
    expect(deriveScope('/feed/shorts')).toMatchObject({ kind: 'shorts-feed' });
    expect(deriveScope('/feed/shorts/foo')).toMatchObject({ kind: 'shorts-feed' });
  });

  it('classifies /@handle and tabs as profile', () => {
    expect(deriveScope('/@fitwithmaya')).toEqual({
      kind: 'profile',
      username: 'fitwithmaya',
      videoId: null,
    });
    expect(deriveScope('/@FitWithMaya/shorts')).toMatchObject({
      kind: 'profile',
      username: 'fitwithmaya',
    });
    expect(deriveScope('/@FitWithMaya/videos')).toMatchObject({ kind: 'profile' });
  });

  it('classifies /channel/<id> as profile', () => {
    expect(deriveScope('/channel/UCxxxxxxxxxxxxxxxxxxxxx')).toEqual({
      kind: 'profile',
      username: 'UCxxxxxxxxxxxxxxxxxxxxx',
      videoId: null,
    });
  });

  it('classifies /c/<name> and /user/<name> legacy URLs as profile', () => {
    expect(deriveScope('/c/SomeName')).toMatchObject({ kind: 'profile', username: 'somename' });
    expect(deriveScope('/user/legacy')).toMatchObject({ kind: 'profile', username: 'legacy' });
  });

  it('classifies search and feed pages as other/search', () => {
    expect(deriveScope('/results')).toMatchObject({ kind: 'search' });
    expect(deriveScope('/results?search_query=foo')).toMatchObject({ kind: 'search' });
    expect(deriveScope('/feed/trending')).toMatchObject({ kind: 'other' });
    expect(deriveScope('/')).toMatchObject({ kind: 'other' });
  });

  it('handles missing input', () => {
    expect(deriveScope()).toMatchObject({ kind: 'other' });
    expect(deriveScope('')).toMatchObject({ kind: 'other' });
  });
});
