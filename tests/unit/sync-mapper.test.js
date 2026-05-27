// Regression tests for the IDB-row → /v1/posts/sync mapper in background.js.
//
// We can't import the SW module directly (background.js uses chrome.* +
// importScripts and isn't ESM), so we extract the pure mapper here and
// verify it stays in lock-step. If background.js's `toSyncPost` is changed,
// this test must be updated in step.

import { describe, it, expect } from 'vitest';
import * as parserIg from '../../src/lib/parser.js';
import * as parserTt from '../../src/lib/parser-tiktok.js';
import * as parserYt from '../../src/lib/parser-youtube.js';
import { scoreFormats } from '../../src/analysis/post-analysis.js';

// --- Mirror of background.js's toSyncPost ----------------------------------
const SYNC_PLATFORMS = new Set(['instagram', 'tiktok', 'youtube']);
const SCOPE_FROM_SURFACE = {
  profile: 'profile',
  reels: 'profile',
  graphql: 'profile',
  explore: 'explore',
  foryou: 'foryou',
  related: 'foryou',
  'shorts-feed': 'shorts-feed',
  search: 'search',
};
const PLATFORM_BY_PREFIX = { ig: 'instagram', tt: 'tiktok', yt: 'youtube' };
const inferPlatform = (p) => {
  if (p && SYNC_PLATFORMS.has(p.platform)) return p.platform;
  const m = String((p?.id) || '').match(/^([a-z]+)_/);
  return m ? PLATFORM_BY_PREFIX[m[1]] || null : null;
};
const stringOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};
const objectFieldString = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = stringOrNull(obj[key]);
    if (value) return value;
  }
  return null;
};
const extractHook = (ai) => {
  if (!ai) return null;
  const h = ai.hook;
  if (typeof h === 'string') return stringOrNull(h);
  return objectFieldString(h, ['text', 'hookText', 'label']);
};
const extractMiddle = (ai) => {
  if (!ai) return null;
  const middle = stringOrNull(ai.middle) || stringOrNull(ai.middleSummary);
  if (middle) return middle;
  return objectFieldString(ai.middle, ['summary', 'text', 'middleSummary', 'label']);
};
const extractCta = (ai) => {
  if (!ai) return null;
  const cta = ai.cta;
  if (typeof cta === 'string') return stringOrNull(cta);
  const fromObj = objectFieldString(cta, ['text', 'ctaText', 'label']);
  return fromObj || stringOrNull(ai.ctaText);
};
const extractType = (value, keys) => {
  if (typeof value === 'string') return stringOrNull(value);
  return objectFieldString(value, keys);
};
const extractTopics = (ai) => {
  if (!ai || !Array.isArray(ai.topics)) return undefined;
  const topics = ai.topics.map((topic) => stringOrNull(topic)).filter(Boolean);
  return topics.length ? topics : undefined;
};
const extractNiche = (ai) => {
  if (!ai) return null;
  return stringOrNull(ai.niche) || stringOrNull(ai.nicheLabel) || objectFieldString(ai.niche, ['label', 'text', 'nicheLabel']);
};
const extractTranscript = (p) => {
  const text = typeof p.transcript === 'string' ? p.transcript : '';
  const segments = Array.isArray(p.transcriptSegments) ? p.transcriptSegments : null;
  if (!text && !(segments?.length)) return undefined;
  const source = typeof p.transcriptSource === 'string' && p.transcriptSource
    ? p.transcriptSource
    : undefined;
  const out = { text };
  if (segments?.length) out.segments = segments;
  if (source) out.source = source;
  return out;
};
const argmaxFormat = (scores) => {
  if (!scores || typeof scores !== 'object') return undefined;
  let best;
  let bestVal = 0;
  for (const k of Object.keys(scores)) {
    const v = Number(scores[k]) || 0;
    if (v > bestVal) { bestVal = v; best = k; }
  }
  return best;
};
const toSyncPost = (p, creatorNicheMap) => {
  if (!p || !p.id) return null;
  const platform = inferPlatform(p);
  if (!platform) return null;
  const nativeId = String(p.nativeId || p.shortcode || p.id.replace(/^[a-z]+_/, ''));
  const scope = SCOPE_FROM_SURFACE[p.surface] || 'profile';
  const postedAt = Number.isFinite(p.createTime) && p.createTime > 0
    ? new Date(p.createTime * (p.createTime > 1e12 ? 1 : 1000)).toISOString()
    : null;
  const usernameLower = p.author ? String(p.author).toLowerCase() : null;
  const ai = p.ai && typeof p.ai === 'object' ? p.ai : null;
  const aiNiche = extractNiche(ai);
  let niche;
  let nicheSource = null;
  if (typeof p.niche === 'string' && p.niche) { niche = p.niche; nicheSource = 'post'; }
  else if (aiNiche) { niche = aiNiche; nicheSource = 'ai'; }
  else if (usernameLower && creatorNicheMap && creatorNicheMap.get) {
    const fromCreator = creatorNicheMap.get(usernameLower);
    if (typeof fromCreator === 'string' && fromCreator) { niche = fromCreator; nicheSource = 'creator'; }
  }

  let formatScores;
  let format;
  const scores = scoreFormats(p);
  if (scores && Object.keys(scores).length) {
    formatScores = scores;
    format = argmaxFormat(scores);
  }
  if (!format && typeof p.format === 'string' && p.format) format = p.format;

  const hook = extractHook(ai);
  const hookType = ai ? extractType(ai.hookType || ai.hook, ['hookType', 'type']) : null;
  const middle = extractMiddle(ai);
  const cta = extractCta(ai);
  const ctaType = ai ? extractType(ai.ctaType || ai.cta, ['ctaType', 'type']) : null;
  const topics = extractTopics(ai);
  const pacing = (ai?.pacing) ? ai.pacing : null;
  const coverAnalysis = p.cover_ai || null;
  const diagnosis = p.diagnosis || null;
  const transcript = extractTranscript(p);
  const outlierScore = Number.isFinite(p._score) && p._score > 0 ? p._score : undefined;
  const velocity = Number.isFinite(p.velocity) ? p.velocity : undefined;
  let nicheBasis = typeof p.nicheBasis === 'string' && p.nicheBasis ? p.nicheBasis : undefined;
  if (!nicheBasis && nicheSource === 'ai') nicheBasis = 'text';
  if (!nicheBasis && nicheSource === 'creator') nicheBasis = 'author';
  const videoUrl = typeof p.videoUrl === 'string' && p.videoUrl ? p.videoUrl : undefined;

  return {
    id: p.id,
    platform,
    nativeId,
    creator: usernameLower ? { platform, username: usernameLower, niche: niche || undefined } : undefined,
    postedAt,
    views: Number.isFinite(p.views) ? p.views : undefined,
    likes: Number.isFinite(p.likes) ? p.likes : undefined,
    comments: Number.isFinite(p.comments) ? p.comments : undefined,
    coverUrl: typeof p.cover === 'string' ? p.cover : undefined,
    durationS: Number.isFinite(p.durationSec) ? Math.round(p.durationSec) : undefined,
    caption: typeof p.desc === 'string' ? p.desc : undefined,
    scope,
    niche: niche || undefined,
    formatScores,
    format,
    nicheBasis,
    hook: hook || undefined,
    hookType: hookType || undefined,
    middle: middle || undefined,
    middleSummary: middle || undefined,
    cta: cta || undefined,
    ctaType: ctaType || undefined,
    topics,
    pacing: pacing || undefined,
    coverAnalysis: coverAnalysis || undefined,
    outlierScore,
    diagnosis: diagnosis || undefined,
    velocity,
    transcript,
    videoUrl,
  };
};

// --- Tests ------------------------------------------------------------------
describe('toSyncPost', () => {
  it('keeps an IG post produced by parser.toPost (regression: was silently dropped)', () => {
    const ig = parserIg.toPost(
      { pk: '4001', code: 'shortA', taken_at: 1736500000, like_count: 1234, view_count: 50000, product_type: 'clips' },
      'profile',
      { kind: 'profile', username: 'someone' },
    );
    // Before the fix, parser.toPost did not set `platform`, and toSyncPost
    // returned null. The id is bare ('4001'); content.js prefixes it on
    // store. Simulate that:
    const stored = { ...ig, id: `ig_${ig.id}` };
    const out = toSyncPost(stored);
    expect(out).not.toBeNull();
    expect(out.platform).toBe('instagram');
    expect(out.id).toBe('ig_4001');
    expect(out.scope).toBe('profile');
  });

  it('keeps a TikTok post (parser sets platform directly)', () => {
    const tt = parserTt.toPost(
      { id: '7001', desc: 'hi', author: { uniqueId: 'tttest' }, stats: { playCount: 10000, diggCount: 100 } },
      'foryou',
      { kind: 'profile', username: 'tttest' },
    );
    const out = toSyncPost(tt);
    expect(out).not.toBeNull();
    expect(out.platform).toBe('tiktok');
    expect(out.scope).toBe('foryou');
  });

  it('infers platform from id prefix when missing', () => {
    expect(toSyncPost({ id: 'ig_x' }).platform).toBe('instagram');
    expect(toSyncPost({ id: 'tt_y' }).platform).toBe('tiktok');
    expect(toSyncPost({ id: 'yt_z' }).platform).toBe('youtube');
  });

  it('drops a row with unknown platform prefix', () => {
    expect(toSyncPost({ id: 'foo_bar' })).toBeNull();
    expect(toSyncPost({ id: 'noprefix' })).toBeNull();
  });

  it('drops a row with no id', () => {
    expect(toSyncPost({ platform: 'instagram' })).toBeNull();
    expect(toSyncPost(null)).toBeNull();
  });

  it("maps every IG `surface` value the parser actually emits to a valid scope", () => {
    // surfaceFromUrlTag in src/lib/parser.js returns: 'reels' | 'explore' |
    // 'profile' | 'graphql'.
    for (const surface of ['profile', 'reels', 'explore', 'graphql']) {
      const out = toSyncPost({ id: 'ig_1', surface });
      expect(out).not.toBeNull();
      expect(out.scope).toBeTruthy();
    }
  });

  it('maps every TikTok `surface` value the parser actually emits', () => {
    // 'foryou' | 'explore' | 'related' | 'profile'
    for (const surface of ['foryou', 'explore', 'related', 'profile']) {
      const out = toSyncPost({ id: 'tt_1', surface });
      expect(out.scope).toBeTruthy();
    }
  });

  it('produces ISO timestamps from numeric createTime in seconds OR ms', () => {
    const sec = toSyncPost({ id: 'ig_1', createTime: 1736500000 });
    expect(sec.postedAt).toMatch(/^2025-/);
    const ms = toSyncPost({ id: 'ig_1', createTime: 1736500000_000 });
    expect(ms.postedAt).toMatch(/^2025-/);
  });

  it('YouTube parser already includes platform=youtube directly', () => {
    const yt = parserYt.playerToPost(
      { videoDetails: { videoId: 'abc123', viewCount: '100', lengthSeconds: '20' } },
      { kind: 'shorts-feed', username: null },
    );
    const out = toSyncPost(yt);
    expect(out).not.toBeNull();
    expect(out.platform).toBe('youtube');
    expect(out.id).toBe('yt_abc123');
    expect(out.scope).toBe('shorts-feed');
  });
});

describe('toSyncPost — creator niche lookup', () => {
  it('stamps niche from creatorNicheMap when post lacks one', () => {
    const map = new Map([['kentjandraa', 'personal-brand']]);
    const out = toSyncPost({ id: 'ig_1', author: 'kentjandraa' }, map);
    expect(out.niche).toBe('personal-brand');
    expect(out.creator.niche).toBe('personal-brand');
  });

  it('lowercases the author lookup key', () => {
    const map = new Map([['kentjandraa', 'personal-brand']]);
    const out = toSyncPost({ id: 'ig_1', author: 'KentJandraa' }, map);
    expect(out.niche).toBe('personal-brand');
  });

  it('prefers post.niche over creatorNicheMap (post-level cluster wins)', () => {
    const map = new Map([['kentjandraa', 'personal-brand']]);
    const out = toSyncPost({ id: 'ig_1', author: 'kentjandraa', niche: 'cinematic-vlog' }, map);
    expect(out.niche).toBe('cinematic-vlog');
  });

  it('uses AI niche when post and creator niche are absent', () => {
    const out = toSyncPost({ id: 'tt_1', author: 'someone', ai: { niche: 'wellness routines' } }, new Map());
    expect(out.niche).toBe('wellness routines');
    expect(out.nicheBasis).toBe('text');
    expect(out.creator.niche).toBe('wellness routines');
  });

  it('leaves niche undefined when neither source has one', () => {
    const out = toSyncPost({ id: 'ig_1', author: 'someone' }, new Map());
    expect(out.niche).toBeUndefined();
    expect(out.creator.niche).toBeUndefined();
  });

  it('works without a map (back-compat with callers that don\'t pass one)', () => {
    const out = toSyncPost({ id: 'ig_1', author: 'someone' });
    expect(out).not.toBeNull();
    expect(out.niche).toBeUndefined();
  });

  it('skips empty-string niche from the map', () => {
    const map = new Map([['x', '']]);
    const out = toSyncPost({ id: 'ig_1', author: 'x' }, map);
    expect(out.niche).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// New optional fields for the website Library page — Hook / Format / Outlier
// / Velocity / CTA columns + click-to-open transcript drawer. All optional;
// each must be omitted (not null) when absent so the server-side validator
// (permissive) doesn't accidentally clobber existing rows.
// ---------------------------------------------------------------------------
describe('toSyncPost — Library-page enrichment fields', () => {
  it('includes every AI / transcript / scoring field when the row has full metadata', () => {
    const row = {
      id: 'ig_5001',
      author: 'someone',
      desc: '5 things every lifter should know about protein',
      durationSec: 32,
      videoUrl: 'https://example.com/v.mp4',
      _score: 3.4,
      velocity: 1200.5,
      niche: 'fitness',
      nicheBasis: 'text',
      ai: {
        hook: 'Most people get protein wrong',
        hookType: 'contrarian',
        middle: 'Explains protein targets and timing mistakes.',
        cta: 'Save this for your next gym day',
        ctaType: 'save',
        topics: ['protein', 'muscle growth', 'meal prep'],
        niche: 'fitness ai fallback',
        pacing: 'medium',
      },
      cover_ai: { hasFace: true, composition: 'centered', expression: 'neutral' },
      diagnosis: { hookStrength: 8, hypothesis: 'opens with a stat-drop' },
      transcript: 'Hello and welcome back to the channel...',
      transcriptSegments: [
        { text: 'Hello and welcome back', start: 0, end: 1.2 },
        { text: 'to the channel', start: 1.2, end: 2.4 },
      ],
      transcriptSource: 'whisper',
    };

    const out = toSyncPost(row);
    // Original fields still present (regression).
    expect(out.id).toBe('ig_5001');
    expect(out.platform).toBe('instagram');
    expect(out.caption).toBe(row.desc);
    expect(out.durationS).toBe(32);

    // Format scores: scoreFormats fires "listicle" + "educational" for this caption.
    expect(out.formatScores).toBeDefined();
    expect(typeof out.formatScores).toBe('object');
    expect(Object.keys(out.formatScores).length).toBeGreaterThan(0);
    // The argmax label must be the key with the highest confidence.
    const expected = Object.entries(out.formatScores).sort((a, b) => b[1] - a[1])[0][0];
    expect(out.format).toBe(expected);

    // Niche + basis surface for the Library page.
    expect(out.niche).toBe('fitness');
    expect(out.nicheBasis).toBe('text');

    // AI extraction fields — hook is the string variant.
    expect(out.hook).toBe('Most people get protein wrong');
    expect(out.hookType).toBe('contrarian');
    expect(out.middle).toBe('Explains protein targets and timing mistakes.');
    expect(out.middleSummary).toBe('Explains protein targets and timing mistakes.');
    expect(out.cta).toBe('Save this for your next gym day');
    expect(out.ctaType).toBe('save');
    expect(out.topics).toEqual(['protein', 'muscle growth', 'meal prep']);
    expect(out.pacing).toBe('medium');

    // Cover + diagnosis pass through as-is.
    expect(out.coverAnalysis).toEqual(row.cover_ai);
    expect(out.diagnosis).toEqual(row.diagnosis);

    // Outlier + velocity come straight off the row (no recomputation here).
    expect(out.outlierScore).toBe(3.4);
    expect(out.velocity).toBe(1200.5);

    // Transcript drawer payload — text, segments, source.
    expect(out.transcript).toBeDefined();
    expect(out.transcript.text).toBe(row.transcript);
    expect(out.transcript.segments).toEqual(row.transcriptSegments);
    expect(out.transcript.source).toBe('whisper');

    // Video URL for click-out / queue-transcription.
    expect(out.videoUrl).toBe('https://example.com/v.mp4');
  });

  it('omits every new field on a bare row — backward compat with pre-AI captures', () => {
    const out = toSyncPost({
      id: 'ig_1',
      author: 'someone',
      // No caption → scoreFormats returns {} and format/formatScores get dropped.
      views: 100,
      likes: 10,
      comments: 1,
    });

    // Original stats survive.
    expect(out.id).toBe('ig_1');
    expect(out.platform).toBe('instagram');
    expect(out.views).toBe(100);
    expect(out.likes).toBe(10);
    expect(out.comments).toBe(1);

    // All new fields must be undefined (NOT null) so the wire JSON omits them.
    expect(out.formatScores).toBeUndefined();
    expect(out.format).toBeUndefined();
    expect(out.nicheBasis).toBeUndefined();
    expect(out.hook).toBeUndefined();
    expect(out.hookType).toBeUndefined();
    expect(out.middle).toBeUndefined();
    expect(out.middleSummary).toBeUndefined();
    expect(out.cta).toBeUndefined();
    expect(out.ctaType).toBeUndefined();
    expect(out.topics).toBeUndefined();
    expect(out.pacing).toBeUndefined();
    expect(out.coverAnalysis).toBeUndefined();
    expect(out.outlierScore).toBeUndefined();
    expect(out.diagnosis).toBeUndefined();
    expect(out.velocity).toBeUndefined();
    expect(out.transcript).toBeUndefined();
    expect(out.videoUrl).toBeUndefined();
  });

  it('preserves the full multi-label formatScores map (not just the argmax)', () => {
    // Caption deliberately fires multiple labels so we exercise the map.
    // "5 things" → listicle, "protein" → educational, "how to" → tutorial.
    const row = {
      id: 'ig_42',
      desc: '5 things about protein — how to actually build muscle',
    };
    const out = toSyncPost(row);
    expect(out.formatScores).toBeDefined();
    const labels = Object.keys(out.formatScores);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels).toContain('listicle');
    // Every confidence is a number in (0, 1] — the noise-floor cut at 0.15 was
    // applied inside scoreFormats(), so each value must be ≥ 0.15.
    for (const label of labels) {
      const v = out.formatScores[label];
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0.15);
      expect(v).toBeLessThanOrEqual(1);
    }
    // The argmax is the highest-confidence label.
    const expected = Object.entries(out.formatScores).sort((a, b) => b[1] - a[1])[0][0];
    expect(out.format).toBe(expected);
  });

  it('extracts hook from the object shape `{ text }` as well as a plain string', () => {
    const fromString = toSyncPost({
      id: 'ig_1', desc: 'x',
      ai: { hook: 'A plain string hook' },
    });
    expect(fromString.hook).toBe('A plain string hook');

    const fromObj = toSyncPost({
      id: 'ig_2', desc: 'x',
      ai: { hook: { text: 'Object-shape hook', hookType: 'stat-drop' } },
    });
    expect(fromObj.hook).toBe('Object-shape hook');

    const fromLabel = toSyncPost({
      id: 'ig_3', desc: 'x',
      ai: { hook: { label: 'Label-only hook' } },
    });
    expect(fromLabel.hook).toBe('Label-only hook');
  });

  it('omits transcript entirely when the row carries no transcript text or segments', () => {
    const out = toSyncPost({
      id: 'ig_1', desc: 'x',
      transcript: '',
      transcriptSegments: null,
      transcriptSource: 'whisper',  // source alone is not enough
    });
    expect(out.transcript).toBeUndefined();
  });

  it('builds the transcript object from segments alone (text empty)', () => {
    const segments = [{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 1, end: 2 }];
    const out = toSyncPost({
      id: 'ig_1', desc: 'x',
      transcript: '',
      transcriptSegments: segments,
      transcriptSource: 'free',
    });
    expect(out.transcript).toEqual({ text: '', segments, source: 'free' });
  });

  it('skips outlierScore when _score is 0, negative, or non-finite (no positive baseline)', () => {
    expect(toSyncPost({ id: 'ig_1', desc: 'x', _score: 0 }).outlierScore).toBeUndefined();
    expect(toSyncPost({ id: 'ig_2', desc: 'x', _score: -1 }).outlierScore).toBeUndefined();
    expect(toSyncPost({ id: 'ig_3', desc: 'x', _score: Number.NaN }).outlierScore).toBeUndefined();
    expect(toSyncPost({ id: 'ig_4', desc: 'x', _score: 2.5 }).outlierScore).toBe(2.5);
  });

  it('falls back to a cached row-level format when scoreFormats returns empty', () => {
    const out = toSyncPost({
      id: 'ig_1',
      desc: '', // no caption → scoreFormats() = {}
      format: 'talking_head',
    });
    expect(out.formatScores).toBeUndefined();
    expect(out.format).toBe('talking_head');
  });

  it('maps TikTok hook, middle, CTA, niche, and format into sync fields', () => {
    const out = toSyncPost({
      id: 'tt_9001',
      platform: 'tiktok',
      nativeId: '9001',
      author: 'TikTokCreator',
      surface: 'foryou',
      desc: 'POV: your morning routine finally sticks #wellness',
      ai: {
        hook: { text: 'Your morning routine finally sticks', hookType: 'direct-address' },
        middle: { summary: 'Shows a repeatable three-step habit stack.' },
        cta: { text: 'Follow for simple routines', ctaType: 'follow' },
        topics: ['morning routine', '', 'habits'],
        niche: 'wellness routines',
      },
    });

    expect(out.platform).toBe('tiktok');
    expect(out.scope).toBe('foryou');
    expect(out.niche).toBe('wellness routines');
    expect(out.nicheBasis).toBe('text');
    expect(out.formatScores).toBeDefined();
    expect(out.format).toBe('pov');
    expect(out.hook).toBe('Your morning routine finally sticks');
    expect(out.hookType).toBe('direct-address');
    expect(out.middleSummary).toBe('Shows a repeatable three-step habit stack.');
    expect(out.cta).toBe('Follow for simple routines');
    expect(out.ctaType).toBe('follow');
    expect(out.topics).toEqual(['morning routine', 'habits']);
  });

  it('maps YouTube hook, middle, CTA, niche, and format into sync fields', () => {
    const out = toSyncPost({
      id: 'yt_short123',
      platform: 'youtube',
      nativeId: 'short123',
      author: 'ShortsCreator',
      surface: 'shorts-feed',
      desc: 'How to edit shorts faster — save this workflow',
      transcript: 'How to edit shorts faster. First set your markers. Then export a reusable preset. Save this workflow.',
      niche: 'shorts editing',
      format: 'tutorial',
      ai: {
        hook: { hookText: 'How to edit shorts faster', type: 'question' },
        middleSummary: 'Walks through markers, presets, and export shortcuts.',
        ctaText: 'Save this workflow',
        ctaType: 'save',
      },
    });

    expect(out.platform).toBe('youtube');
    expect(out.scope).toBe('shorts-feed');
    expect(out.niche).toBe('shorts editing');
    expect(out.format).toBe('tutorial');
    expect(out.hook).toBe('How to edit shorts faster');
    expect(out.hookType).toBe('question');
    expect(out.middle).toBe('Walks through markers, presets, and export shortcuts.');
    expect(out.cta).toBe('Save this workflow');
    expect(out.ctaType).toBe('save');
    expect(out.transcript.text).toContain('How to edit shorts faster');
  });
});
