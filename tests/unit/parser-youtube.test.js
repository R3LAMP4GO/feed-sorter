import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  captionTracksOf,
  pickCaptionTrack,
  videoUrlOfPlayer,
  playerToPost,
  parseCaptionsXml,
  parseCaptionsJson3,
  harvestBrowse,
  enrichFromNext,
  surfaceFromUrlTag,
  ID_PREFIX_YT,
} from '../../src/lib/parser-youtube.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) =>
  JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf8'));

describe('parser-youtube', () => {
  describe('captionTracksOf', () => {
    it('extracts every track with stable shape', () => {
      const player = loadFixture('youtube-player.json');
      const tracks = captionTracksOf(player);
      expect(tracks).toHaveLength(2);
      expect(tracks[0]).toMatchObject({
        languageCode: 'en',
        kind: 'asr',
        baseUrl: expect.stringContaining('lang=en'),
      });
      expect(tracks[1].kind).toBe('');
    });

    it('returns [] when missing', () => {
      expect(captionTracksOf({})).toEqual([]);
      expect(captionTracksOf(null)).toEqual([]);
    });
  });

  describe('pickCaptionTrack', () => {
    it('prefers human caption in preferred lang over ASR', () => {
      const tracks = [
        { languageCode: 'en', kind: 'asr', baseUrl: 'A' },
        { languageCode: 'es', kind: '', baseUrl: 'B' },
      ];
      // No human-en exists, so falls back to ASR-en (still preferred lang)
      expect(pickCaptionTrack(tracks, 'en').baseUrl).toBe('A');
    });

    it('prefers human over ASR when both exist in preferred lang', () => {
      const tracks = [
        { languageCode: 'en', kind: 'asr', baseUrl: 'A' },
        { languageCode: 'en', kind: '', baseUrl: 'B' },
      ];
      expect(pickCaptionTrack(tracks, 'en').baseUrl).toBe('B');
    });

    it('returns null on empty', () => {
      expect(pickCaptionTrack([])).toBeNull();
      expect(pickCaptionTrack(null)).toBeNull();
    });
  });

  describe('videoUrlOfPlayer', () => {
    it('extracts the mp4 url from formats[]', () => {
      const player = loadFixture('youtube-player.json');
      const url = videoUrlOfPlayer(player);
      expect(url).toMatch(/googlevideo\.com\/videoplayback/);
    });
  });

  describe('playerToPost', () => {
    it('namespaces the id with yt_ prefix and hydrates fields', () => {
      const player = loadFixture('youtube-player.json');
      const post = playerToPost(player, { kind: 'shorts-feed', username: null });
      expect(post.id).toBe(`${ID_PREFIX_YT}abc123XYZ_-`);
      expect(post.author).toBe('fit with maya');
      expect(post.platform).toBe('youtube');
      expect(post.surface).toBe('shorts-feed');
      expect(post.views).toBe(1234567);
      expect(post.durationSec).toBe(47);
      expect(post.url).toBe('https://www.youtube.com/shorts/abc123XYZ_-');
      expect(post.captionTracks).toHaveLength(2);
    });

    it('does not overwrite player author with shorts page scope', () => {
      const player = loadFixture('youtube-player.json');
      const post = playerToPost(player, { kind: 'shorts-feed', username: null, videoId: 'abc123XYZ_-' });
      expect(post.author).toBe('fit with maya');
    });

    it('returns null without videoId', () => {
      expect(playerToPost({}, { kind: 'profile' })).toBeNull();
    });
  });

  describe('parseCaptionsXml', () => {
    it('parses <text> entries into segments + flat text', () => {
      const xml = `<?xml version="1.0"?>
        <transcript>
          <text start="0" dur="2.5">Hello &amp; welcome</text>
          <text start="2.5" dur="3">to my morning routine.</text>
        </transcript>`;
      const r = parseCaptionsXml(xml);
      expect(r.segments).toHaveLength(2);
      expect(r.segments[0]).toMatchObject({ start: 0, end: 2.5, text: 'Hello & welcome' });
      expect(r.fullText).toBe('Hello & welcome to my morning routine.');
    });
  });

  describe('parseCaptionsJson3', () => {
    it('joins segs[].utf8 per event', () => {
      const json = {
        events: [
          { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
          { tStartMs: 2500, dDurationMs: 3000, segs: [{ utf8: 'how are you' }] },
        ],
      };
      const r = parseCaptionsJson3(json);
      expect(r.segments).toHaveLength(2);
      expect(r.fullText).toBe('Hello world how are you');
      expect(r.segments[0].end).toBeCloseTo(2.5);
    });
  });

  describe('harvestBrowse', () => {
    it('finds shorts items with videoId + title', () => {
      const browse = loadFixture('youtube-browse.json');
      const posts = harvestBrowse(browse, { kind: 'shorts-feed', username: null });
      expect(posts.length).toBeGreaterThanOrEqual(2);
      expect(posts[0].id.startsWith('yt_')).toBe(true);
      expect(posts[0].platform).toBe('youtube');
    });

    it('parses modern shorts lockup view models with compact view counts', () => {
      const browse = {
        contents: {
          richGridRenderer: {
            contents: [
              {
                richItemRenderer: {
                  content: {
                    shortsLockupViewModel: {
                      entityId: 'shorts-lockup-ZYxwVuT9876',
                      accessibilityText: 'Debates Capital by Debates Capital 238K views',
                      overlayMetadata: {
                        primaryText: { content: 'Debates Capital' },
                        secondaryText: { content: '238K views' },
                      },
                      onTap: {
                        innertubeCommand: {
                          reelWatchEndpoint: { videoId: 'ZYxwVuT9876' },
                          commandMetadata: { webCommandMetadata: { url: '/shorts/ZYxwVuT9876' } },
                        },
                      },
                      thumbnailViewModel: {
                        image: { sources: [{ url: 'https://i.ytimg.com/vi/ZYxwVuT9876/oar2.jpg' }] },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      };

      const posts = harvestBrowse(browse, { kind: 'shorts-feed', username: null });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        id: 'yt_ZYxwVuT9876',
        title: 'Debates Capital',
        views: 238000,
        cover: 'https://i.ytimg.com/vi/ZYxwVuT9876/oar2.jpg',
      });
    });

    it('normalizes relative thumbnails and falls back to ytimg when absent', () => {
      const relativePosts = harvestBrowse({
        shortsLockupViewModel: {
          entityId: 'shorts-lockup-RELATIVE123',
          overlayMetadata: { primaryText: { content: 'Relative thumb' }, secondaryText: { content: '12K views' } },
          thumbnail: { thumbnails: [{ url: '/vi/RELATIVE123/hqdefault.jpg' }] },
        },
      }, { kind: 'shorts-feed', username: null });
      expect(relativePosts[0].cover).toBe('https://i.ytimg.com/vi/RELATIVE123/hqdefault.jpg');

      const fallbackPosts = harvestBrowse({
        shortsLockupViewModel: {
          entityId: 'shorts-lockup-MISSING1234',
          overlayMetadata: { primaryText: { content: 'Missing thumb' }, secondaryText: { content: '7K views' } },
        },
      }, { kind: 'shorts-feed', username: null });
      expect(fallbackPosts[0].cover).toBe('https://i.ytimg.com/vi/MISSING1234/hqdefault.jpg');
    });
  });

  describe('enrichFromNext', () => {
    it('walks the deep tree for likes / views / uploadedAt', () => {
      const next = loadFixture('youtube-next.json');
      const out = enrichFromNext(next);
      expect(out.likes).toBe(89432);
      expect(out.views).toBe(1234567);
      // dateText "Mar 15, 2026" → unix seconds (locale-independent).
      const expected = Math.floor(Date.parse('Mar 15, 2026') / 1000);
      expect(out.uploadedAt).toBe(expected);
    });

    it('reads modern Shorts engagement buttons and current video id', () => {
      const next = {
        currentVideoEndpoint: { reelWatchEndpoint: { videoId: 'ZYxwVuT9876' } },
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              header: {
                engagementPanelTitleHeaderRenderer: {
                  contextualInfo: { content: '1.2K comments' },
                },
              },
            },
          },
        ],
        overlay: {
          reelPlayerOverlayRenderer: {
            viewCountText: { simpleText: '2.4M views' },
            likeButton: {
              likeButtonViewModel: {
                likeCount: '153K',
                buttonViewModel: { accessibilityText: '153K likes' },
              },
            },
            commentsButton: {
              buttonRenderer: { accessibility: { accessibilityData: { label: '1.2K comments' } } },
            },
          },
        },
      };

      expect(enrichFromNext(next)).toMatchObject({
        videoId: 'ZYxwVuT9876',
        likes: 153000,
        views: 2400000,
        comments: 1200,
      });
    });

    it('reads reel_item_watch engagement and creator metadata', () => {
      const next = {
        videoId: 'n9TZu_Sa55k',
        overlay: {
          reelPlayerOverlayRenderer: {
            ownerText: {
              runs: [
                {
                  text: 'Hydra culture',
                  navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/@Hydra_culture' } } },
                },
              ],
            },
            likeButton: { likeButtonViewModel: { likeCount: '669K' } },
            commentsButton: { buttonRenderer: { accessibilityData: { label: '6,034 comments' } } },
            viewCountText: { simpleText: '916.4K views' },
          },
        },
      };

      expect(enrichFromNext(next)).toMatchObject({
        videoId: 'n9TZu_Sa55k',
        author: 'hydra_culture',
        likes: 669000,
        views: 916400,
        comments: 6034,
      });
    });

    it('reads current Shorts likeCountEntity and comment button text', () => {
      const next = {
        currentVideoEndpoint: { reelWatchEndpoint: { videoId: 'gpForThree' } },
        overlay: {
          reelPlayerOverlayRenderer: {
            likeButton: {
              likeButtonViewModel: {
                likeCountEntity: { likeCountIfIndifferent: '344' },
              },
            },
            commentsButton: {
              buttonRenderer: {
                text: { simpleText: '10' },
                accessibilityData: { label: '10 comments' },
              },
            },
            viewCountText: { simpleText: '13.9K views' },
          },
        },
      };

      expect(enrichFromNext(next)).toMatchObject({
        videoId: 'gpForThree',
        likes: 344,
        comments: 10,
        views: 13900,
      });
    });

    it('returns zeros on empty input', () => {
      expect(enrichFromNext({})).toEqual({ likes: 0, views: 0, comments: 0, uploadedAt: 0 });
      expect(enrichFromNext(null)).toEqual({ likes: 0, views: 0, comments: 0, uploadedAt: 0 });
    });
  });

  describe('surfaceFromUrlTag', () => {
    it('honors the explicit DNR tag first', () => {
      expect(surfaceFromUrlTag('https://example.com/anything', 'yt-shorts')).toBe('shorts-feed');
      expect(surfaceFromUrlTag('https://example.com/anything', 'yt-player')).toBe('player');
      expect(surfaceFromUrlTag('https://example.com/anything', 'yt-next')).toBe('next');
    });

    it('falls back to URL pattern when the tag is missing', () => {
      expect(surfaceFromUrlTag('https://www.youtube.com/youtubei/v1/browse?abc', '')).toBe('shorts-feed');
      expect(surfaceFromUrlTag('https://www.youtube.com/youtubei/v1/player?abc', '')).toBe('player');
      expect(surfaceFromUrlTag('https://www.youtube.com/youtubei/v1/next?abc', '')).toBe('next');
      expect(surfaceFromUrlTag('https://www.youtube.com/youtubei/v1/reel/reel_item_watch?abc', '')).toBe('next');
      expect(surfaceFromUrlTag('https://www.youtube.com/youtubei/v1/reel/reel_watch_sequence?abc', '')).toBe('shorts-feed');
    });

    it('returns "unknown" for everything else', () => {
      expect(surfaceFromUrlTag('https://example.com/anything', '')).toBe('unknown');
      expect(surfaceFromUrlTag('', '')).toBe('unknown');
    });
  });
});
