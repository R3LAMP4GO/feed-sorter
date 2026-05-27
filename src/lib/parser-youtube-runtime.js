// IIFE mirror of src/lib/parser-youtube.js for content scripts. Keep in
// lock-step. Exposes window.FeedSorterYouTubeParser.

(() => {
  const ID_PREFIX = 'yt_';
  const SHORTS_ID_RE = /\/shorts\/([A-Za-z0-9_-]{6,})/;
  const WATCH_ID_RE = /[?&]v=([A-Za-z0-9_-]{6,})/;
  const ENTITY_ID_RE = /^shorts(?:-shelf-item|-grid-item|-lockup)?-([A-Za-z0-9_-]{6,})$/i;
  const COUNT_RE = /(\d[\d,.\s]*\d|\d)(?:\s*([kmb]|thousand|million|billion))?/i;
  const HANDLE_RE = /\/@([^/?#]+)/;
  const YOUTUBE_ENDPOINT_SURFACES = Object.freeze({
    browse: 'shorts-feed',
    player: 'player',
    next: 'next',
    reel_item_watch: 'next',
    reel_watch_sequence: 'shorts-feed',
  });

  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  const str = (v) => (v == null ? '' : String(v));

  function textFrom(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return str(value);
    if (Array.isArray(value)) return value.map((v) => textFrom(v)).join('');
    if (typeof value !== 'object') return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) {
      return value.runs.map((r) => str((r && (r.text || r.content)) || '')).join('');
    }
    if (typeof value.content === 'string') return value.content;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.accessibilityText === 'string') return value.accessibilityText;
    if (typeof value.label === 'string') return value.label;
    const accessibilityLabel =
      value.accessibility?.accessibilityData?.label ||
      value.accessibilityData?.label ||
      value.accessibility?.label;
    return str(accessibilityLabel);
  }

  function firstText(...values) {
    for (const value of values) {
      const text = textFrom(value).trim();
      if (text) return text;
    }
    return '';
  }

  function firstHandleFrom(value) {
    const raw = textFrom(value) || str(value);
    const match = raw.match(HANDLE_RE);
    return match ? cleanAuthor(match[1]) : '';
  }

  function suffixMultiplier(suffix) {
    const s = String(suffix || '').toLowerCase();
    if (s === 'k' || s === 'thousand') return 1000;
    if (s === 'm' || s === 'million') return 1000000;
    if (s === 'b' || s === 'billion') return 1000000000;
    return 1;
  }

  function normalizeCountToken(token, hasSuffix) {
    let value = String(token || '').replace(/\s+/g, '');
    if (!value) return '';

    const hasComma = value.indexOf(',') !== -1;
    const hasDot = value.indexOf('.') !== -1;
    if (hasComma && hasDot) {
      const lastComma = value.lastIndexOf(',');
      const lastDot = value.lastIndexOf('.');
      const decimalSep = lastComma > lastDot ? ',' : '.';
      const decimalDigits = value.length - Math.max(lastComma, lastDot) - 1;
      if (!hasSuffix && decimalDigits === 3) return value.replace(/[,.]/g, '');
      if (decimalSep === ',') return value.replace(/\./g, '').replace(',', '.');
      return value.replace(/,/g, '');
    }

    if (hasComma || hasDot) {
      const sep = hasComma ? ',' : '.';
      const parts = value.split(sep);
      const last = parts[parts.length - 1] || '';
      const looksGrouped = parts.length > 2 || last.length === 3;
      value = looksGrouped ? parts.join('') : parts.join('.');
    }
    return value;
  }

  function parseLooseNumber(value) {
    const raw = (textFrom(value) || str(value)).replace(/\u00a0/g, ' ').trim();
    if (!/\d/.test(raw)) return 0;
    const match = raw.match(COUNT_RE);
    if (!match) return 0;
    const normalized = normalizeCountToken(match[1], !!match[2]);
    const base = Number(normalized);
    if (!Number.isFinite(base)) return 0;
    return Math.round(base * suffixMultiplier(match[2]));
  }

  function parseDurationSeconds(value) {
    const raw = textFrom(value).trim();
    const match = raw.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
    if (match) {
      const hours = Number(match[1] || 0);
      const minutes = Number(match[2] || 0);
      const seconds = Number(match[3] || 0);
      return (hours * 3600) + (minutes * 60) + seconds;
    }
    return parseLooseNumber(raw);
  }

  function parseDateSeconds(value) {
    const raw = textFrom(value).trim();
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }

  function extractVideoIdFromString(value) {
    const raw = str(value).trim();
    if (!raw) return '';
    const entity = raw.match(ENTITY_ID_RE);
    if (entity) return entity[1];
    const shorts = raw.match(SHORTS_ID_RE);
    if (shorts) return shorts[1];
    const watch = raw.match(WATCH_ID_RE);
    if (watch) return watch[1];
    if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) return raw;
    return '';
  }

  function firstVideoId(...values) {
    for (const value of values) {
      const id = extractVideoIdFromString(value);
      if (id) return id;
    }
    return '';
  }

  function videoIdFromObject(value) {
    if (!value || typeof value !== 'object') return extractVideoIdFromString(value);
    return firstVideoId(
      value.videoId,
      value.video_id,
      value.reelWatchEndpoint?.videoId,
      value.watchEndpoint?.videoId,
      value.currentVideoEndpoint?.reelWatchEndpoint?.videoId,
      value.currentVideoEndpoint?.watchEndpoint?.videoId,
      value.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId,
      value.onTap?.innertubeCommand?.watchEndpoint?.videoId,
      value.navigationEndpoint?.reelWatchEndpoint?.videoId,
      value.navigationEndpoint?.watchEndpoint?.videoId,
      value.onTapCommand?.innertubeCommand?.reelWatchEndpoint?.videoId,
      value.onTapCommand?.innertubeCommand?.watchEndpoint?.videoId,
      value.command?.reelWatchEndpoint?.videoId,
      value.command?.watchEndpoint?.videoId,
      value.endpoint?.reelWatchEndpoint?.videoId,
      value.endpoint?.watchEndpoint?.videoId,
      value.inlinePlayerData?.onVisible?.innertubeCommand?.reelWatchEndpoint?.videoId,
      value.inlinePlayerData?.onVisible?.innertubeCommand?.watchEndpoint?.videoId,
      value.entityId,
      value.videoDetails?.videoId,
      value.commandMetadata?.webCommandMetadata?.url,
      value.onTap?.innertubeCommand?.commandMetadata?.webCommandMetadata?.url,
      value.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url,
      value.url,
      value.canonicalBaseUrl
    );
  }

  function currentVideoIdFromObject(value) {
    if (!value || typeof value !== 'object') return '';
    return firstVideoId(
      value.currentVideoEndpoint?.reelWatchEndpoint?.videoId,
      value.currentVideoEndpoint?.watchEndpoint?.videoId,
      value.videoId,
      value.video_id,
      value.videoDetails?.videoId,
      value.playerResponse?.videoDetails?.videoId,
      value.currentVideoEndpoint?.commandMetadata?.webCommandMetadata?.url,
      value.navigationEndpoint?.reelWatchEndpoint?.videoId,
      value.endpoint?.reelWatchEndpoint?.videoId
    );
  }

  function cleanAuthor(value) {
    return str(value).replace(/^@/, '').trim().toLowerCase();
  }

  function normalizeThumbnailUrl(value) {
    const raw = str(value).trim();
    if (!raw) return '';
    if (raw.indexOf('//') === 0) return `https:${raw}`;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.indexOf('/vi/') === 0 || raw.indexOf('/vi_webp/') === 0) return `https://i.ytimg.com${raw}`;
    if (raw.indexOf('/') === 0) return `https://www.youtube.com${raw}`;
    return raw;
  }

  function fallbackThumbnailUrl(videoId, quality) {
    const id = str(videoId).trim();
    return id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${quality || 'hqdefault'}.jpg` : '';
  }

  function thumbnailUrlOf(value) {
    if (!value || typeof value !== 'object') return '';
    const arrays = [
      value.thumbnail?.thumbnails,
      value.thumbnail?.sources,
      value.thumbnailViewModel?.image?.sources,
      value.image?.sources,
      value.richThumbnail?.movingThumbnailRenderer?.movingThumbnailDetails?.thumbnails,
    ];
    for (const arr of arrays) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const urls = arr.map((t) => normalizeThumbnailUrl(t?.url || t?.src)).filter(Boolean);
      const found = urls[urls.length - 1];
      if (found) return found;
    }
    return normalizeThumbnailUrl(value.thumbnail?.url || value.thumbnailUrl || '');
  }

  function maxCountForKeyword(root, keywordRe, maxDepth) {
    let out = 0;
    const stack = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    const limit = maxDepth == null ? 4 : maxDepth;
    while (stack.length) {
      const item = stack.pop();
      const value = item.value;
      const depth = item.depth;
      if (value == null) continue;
      const text = textFrom(value);
      if (text && keywordRe.test(text) && /\d/.test(text)) {
        out = Math.max(out, parseLooseNumber(text));
      }
      if (typeof value !== 'object' || depth >= limit || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const child of value) stack.push({ value: child, depth: depth + 1 });
      } else {
        for (const key in value) stack.push({ value: value[key], depth: depth + 1 });
      }
    }
    return out;
  }

  function captionTracksOf(player) {
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map((t) => ({
      baseUrl: str(t?.baseUrl),
      languageCode: str(t?.languageCode),
      name: str(t?.name?.simpleText || t?.name?.runs?.[0]?.text || ''),
      kind: str(t?.kind),
    }));
  }

  function pickCaptionTrack(tracks, preferredLang) {
    const lang = preferredLang || 'en';
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const pref = (value) => (t) => t.languageCode.toLowerCase().indexOf(value.toLowerCase()) === 0;
    const nonAsr = tracks.filter((t) => t.kind !== 'asr');
    return nonAsr.find(pref(lang)) || tracks.find(pref(lang)) || nonAsr[0] || tracks[0];
  }

  function videoUrlOfPlayer(player) {
    const formats = player?.streamingData?.formats;
    if (Array.isArray(formats)) {
      const mp4Combined = formats.find((x) => typeof x.url === 'string' && /video\/mp4/i.test(x.mimeType || ''));
      if (mp4Combined?.url) return mp4Combined.url;
    }
    const adaptive = player?.streamingData?.adaptiveFormats;
    if (Array.isArray(adaptive)) {
      const anyVideo = adaptive.find((x) => typeof x.url === 'string' && /video\/mp4/i.test(x.mimeType || ''));
      if (anyVideo?.url) return anyVideo.url;
    }
    return '';
  }

  function playerToPost(player, pageScope) {
    const ps = pageScope || { kind: 'other', username: null };
    const vd = player?.videoDetails || {};
    const micro = player?.microformat?.playerMicroformatRenderer || {};
    const nativeId = str(vd.videoId);
    if (!nativeId) return null;
    const ownerHandle = firstHandleFrom(micro.ownerProfileUrl);
    const handle = cleanAuthor(ownerHandle || vd.author || micro.ownerChannelName);
    const cover = thumbnailUrlOf(vd) || thumbnailUrlOf(micro) || fallbackThumbnailUrl(nativeId);
    const surface = ps.kind === 'shorts-feed' ? 'shorts-feed' : ps.kind;
    return {
      id: ID_PREFIX + nativeId,
      nativeId,
      shortcode: nativeId,
      author: handle,
      channelId: str(vd.channelId || micro.externalChannelId),
      desc: str(vd.shortDescription || vd.title || micro.description?.simpleText || ''),
      title: str(vd.title || textFrom(micro.title)),
      createTime: parseDateSeconds(micro.publishDate || micro.uploadDate),
      likes: 0,
      comments: 0,
      views: Math.max(parseLooseNumber(vd.viewCount), parseLooseNumber(micro.viewCount)),
      shares: 0,
      saves: 0,
      durationSec: num(vd.lengthSeconds),
      mediaType: 2,
      isReel: true,
      cover: str(cover),
      videoUrl: videoUrlOfPlayer(player),
      url: `https://www.youtube.com/shorts/${nativeId}`,
      surface,
      platform: 'youtube',
      audio: null,
      audioClusterId: '',
      usertags: [],
      coauthors: [],
      location: null,
      accessibilityCaption: '',
      carouselCount: 0,
      productType: 'video',
      captionTracks: captionTracksOf(player),
    };
  }

  function likeCountFromObject(value) {
    if (!value || typeof value !== 'object') return 0;
    const likeCountEntity = value.likeCountEntity || value.likeButtonViewModel?.likeCountEntity || value.likeButtonViewModel?.likeButtonViewModel?.likeCountEntity;
    let out = Math.max(
      parseLooseNumber(value.likeCount),
      parseLooseNumber(value.likeCountText),
      parseLooseNumber(value.shortLikeCount),
      parseLooseNumber(value.shortLikeCountText),
      parseLooseNumber(value.likeButtonViewModel?.likeCount),
      parseLooseNumber(value.likeButtonViewModel?.likeButtonViewModel?.likeCount),
      parseLooseNumber(likeCountEntity?.likeCountIfIndifferent),
      parseLooseNumber(likeCountEntity?.likeCountIfDisliked),
      parseLooseNumber(likeCountEntity?.expandedLikeCountIfIndifferent),
      parseLooseNumber(likeCountEntity?.expandedLikeCountIfDisliked),
      parseLooseNumber(likeCountEntity?.likeCountIfLiked),
      parseLooseNumber(likeCountEntity?.expandedLikeCountIfLiked)
    );

    const renderer = value.toggleButtonRenderer || value.likeButtonRenderer;
    if (renderer) {
      out = Math.max(
        out,
        parseLooseNumber(renderer.defaultText),
        parseLooseNumber(renderer.toggledText),
        parseLooseNumber(renderer.accessibility),
        parseLooseNumber(renderer.accessibilityData),
        parseLooseNumber(renderer.title),
        parseLooseNumber(renderer.tooltip)
      );
    }

    const label = firstText(
      value.accessibilityText,
      value.accessibility?.accessibilityData?.label,
      value.accessibilityData?.label,
      value.buttonViewModel?.accessibilityText,
      value.buttonViewModel?.title,
      value.defaultButtonViewModel?.buttonViewModel?.accessibilityText,
      value.defaultButtonViewModel?.buttonViewModel?.title,
      value.likeButtonViewModel?.likeCount,
      value.likeButtonViewModel?.accessibilityText,
      value.likeButtonViewModel?.buttonViewModel?.accessibilityText,
      value.likeButtonViewModel?.buttonViewModel?.title,
      value.likeButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.accessibilityText,
      value.likeButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.title
    );
    if (label && !/\bdislike\b/i.test(label) && (/\blikes?\b/i.test(label) || /other people/i.test(label))) {
      out = Math.max(out, parseLooseNumber(label));
    }
    return out;
  }

  function viewCountFromObject(value) {
    if (!value || typeof value !== 'object') return 0;
    let out = Math.max(
      parseLooseNumber(value.viewCount),
      parseLooseNumber(value.viewCountText),
      parseLooseNumber(value.shortViewCount),
      parseLooseNumber(value.shortViewCountText)
    );
    const label = firstText(
      value.accessibilityText,
      value.accessibility?.accessibilityData?.label,
      value.accessibilityData?.label
    );
    if (label && /\bviews?\b/i.test(label)) out = Math.max(out, parseLooseNumber(label));
    return out;
  }

  function commentCountFromObject(value) {
    if (!value || typeof value !== 'object') return 0;
    const commentButton = value.commentButton || value.commentsButton;
    const commentButtonRenderer = commentButton?.buttonRenderer || value.commentButtonRenderer || value.commentsButtonRenderer;
    const commentButtonViewModel = commentButton?.buttonViewModel || value.commentButtonViewModel || value.commentsButtonViewModel;
    let out = Math.max(
      parseLooseNumber(value.commentCount),
      parseLooseNumber(value.commentCountText),
      parseLooseNumber(value.commentsCount),
      parseLooseNumber(value.commentsCountText),
      parseLooseNumber(value.commentButtonViewModel?.commentCount),
      parseLooseNumber(value.commentsButtonViewModel?.commentCount),
      parseLooseNumber(value.commentCountEntity?.commentCount),
      parseLooseNumber(value.commentsEntryPointHeaderRenderer?.commentCount),
      parseLooseNumber(commentButtonRenderer?.text),
      parseLooseNumber(commentButtonRenderer?.title),
      parseLooseNumber(commentButtonViewModel?.title),
      parseLooseNumber(commentButtonViewModel?.commentCount)
    );
    const label = firstText(
      value.contextualInfo,
      value.accessibilityText,
      value.accessibility?.accessibilityData?.label,
      value.accessibilityData?.label,
      value.buttonViewModel?.accessibilityText,
      value.buttonViewModel?.title,
      value.buttonRenderer?.accessibility?.accessibilityData?.label,
      value.buttonRenderer?.accessibilityData?.label,
      value.commentButtonViewModel?.accessibilityText,
      value.commentsButtonViewModel?.accessibilityText,
      commentButtonRenderer?.accessibility?.accessibilityData?.label,
      commentButtonRenderer?.accessibilityData?.label,
      commentButtonViewModel?.accessibilityText
    );
    if (label && /\bcomments?\b/i.test(label)) out = Math.max(out, parseLooseNumber(label));
    return out;
  }

  function dateFromObject(value) {
    if (!value || typeof value !== 'object') return 0;
    return Math.max(
      parseDateSeconds(value.dateText),
      parseDateSeconds(value.publishedTimeText),
      parseDateSeconds(value.publishDate),
      parseDateSeconds(value.uploadDate),
      parseDateSeconds(value.microformat?.playerMicroformatRenderer?.publishDate),
      parseDateSeconds(value.microformat?.playerMicroformatRenderer?.uploadDate)
    );
  }

  function enrichFromNext(next) {
    const out = { likes: 0, views: 0, comments: 0, uploadedAt: 0 };
    const stack = [next];
    const seen = new WeakSet();
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);

      if (!out.videoId) {
        const currentVideoId = currentVideoIdFromObject(value);
        if (currentVideoId) out.videoId = currentVideoId;
      }
      if (!out.author) {
        const foundAuthor = firstAuthorFromObject(value);
        if (foundAuthor) out.author = foundAuthor;
      }
      out.likes = Math.max(out.likes, likeCountFromObject(value));
      out.views = Math.max(out.views, viewCountFromObject(value));
      out.comments = Math.max(out.comments, commentCountFromObject(value));
      if (!out.uploadedAt) out.uploadedAt = dateFromObject(value);

      if (Array.isArray(value)) for (const item of value) stack.push(item);
      else for (const key in value) stack.push(value[key]);
    }
    return out;
  }

  function firstAuthorFromObject(value) {
    if (!value || typeof value !== 'object') return '';
    return cleanAuthor(
      firstHandleFrom(value.ownerProfileUrl) ||
      firstHandleFrom(value.canonicalBaseUrl) ||
      firstHandleFrom(value.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url) ||
      firstHandleFrom(value.endpoint?.commandMetadata?.webCommandMetadata?.url) ||
      firstHandleFrom(value.commandMetadata?.webCommandMetadata?.url) ||
      firstHandleFrom(value.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url) ||
      firstHandleFrom(value.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url) ||
      firstHandleFrom(value.longBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url) ||
      firstText(
        value.ownerText,
        value.shortBylineText,
        value.longBylineText,
        value.byline,
        value.channelName,
        value.ownerChannelName,
        value.metadata?.channelName,
        value.author,
        value.videoDetails?.author,
        value.playerResponse?.videoDetails?.author
      )
    );
  }

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  }

  function parseCaptionsXml(xml) {
    const segments = [];
    const tagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    const attrOf = (attrs, name) => {
      const m2 = attrs.match(new RegExp(`\\b${name}="([^"]+)"`));
      return m2 ? m2[1] : '';
    };
    let m;
    while ((m = tagRe.exec(xml))) {
      const attrs = m[1] || '';
      const start = Number(attrOf(attrs, 'start')) || 0;
      const dur = Number(attrOf(attrs, 'dur')) || 0;
      const text = decodeXmlEntities(m[2]).replace(/<[^>]+>/g, '').trim();
      if (text) segments.push({ start, end: start + dur, text });
    }
    return { fullText: segments.map((s) => s.text).join(' ').trim(), segments };
  }

  function parseCaptionsJson3(json) {
    const events = json?.events;
    if (!Array.isArray(events)) return { fullText: '', segments: [] };
    const segments = [];
    for (const ev of events) {
      if (!Array.isArray(ev.segs)) continue;
      const start = (Number(ev.tStartMs) || 0) / 1000;
      const dur = (Number(ev.dDurationMs) || 0) / 1000;
      const text = ev.segs.map((s) => String(s?.utf8 || '')).join('').trim();
      if (text) segments.push({ start, end: start + dur, text });
    }
    return { fullText: segments.map((s) => s.text).join(' ').trim(), segments };
  }

  function looksLikeBrowseVideo(value) {
    if (!videoIdFromObject(value)) return false;
    if (
      value.headline ||
      value.title ||
      value.shortBylineText ||
      value.ownerText ||
      value.longBylineText ||
      value.viewCountText ||
      value.shortViewCountText ||
      value.thumbnail ||
      value.thumbnailViewModel ||
      value.overlayMetadata ||
      value.onTap?.innertubeCommand?.reelWatchEndpoint ||
      value.navigationEndpoint?.reelWatchEndpoint
    ) {
      return true;
    }
    const accessibilityText = firstText(value.accessibilityText, value.accessibility?.accessibilityData?.label);
    return /\bviews?\b/i.test(accessibilityText);
  }

  function titleOfBrowseItem(value) {
    return firstText(
      value.title,
      value.headline,
      value.overlayMetadata?.primaryText,
      value.metadata?.title,
      value.accessibilityText,
      value.accessibility?.accessibilityData?.label
    ).replace(/\s+by\s+.+?\s+\d[\d,.\s]*(?:[KMB]|thousand|million|billion)?\s+views?$/i, '').trim();
  }

  function authorOfBrowseItem(value, pageScope) {
    if (pageScope?.username) return cleanAuthor(pageScope.username);
    const handle = firstHandleFrom(
      firstText(
        value.shortBylineText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url,
        value.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url,
        value.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url,
        value.onTap?.innertubeCommand?.commandMetadata?.webCommandMetadata?.url,
        value.onTapCommand?.innertubeCommand?.commandMetadata?.webCommandMetadata?.url,
        value.canonicalBaseUrl
      )
    );
    if (handle) return handle;
    const byline = firstText(
      value.shortBylineText,
      value.ownerText,
      value.longBylineText,
      value.byline,
      value.channelName,
      value.metadata?.channelName
    );
    if (byline) return cleanAuthor(byline);
    const accessibilityText = firstText(value.accessibilityText, value.accessibility?.accessibilityData?.label);
    const authorMatch = accessibilityText.match(/\sby\s+(.+?)\s+\d[\d,.\s]*(?:[KMB]|thousand|million|billion)?\s+views?\b/i);
    return cleanAuthor(authorMatch?.[1] || '');
  }

  function viewsOfBrowseItem(value) {
    return Math.max(
      parseLooseNumber(value.viewCountText),
      parseLooseNumber(value.shortViewCountText),
      parseLooseNumber(value.overlayMetadata?.secondaryText),
      maxCountForKeyword(value, /\bviews?\b/i, 4)
    );
  }

  function browseItemToPost(value, pageScope) {
    const nativeId = videoIdFromObject(value);
    if (!nativeId) return null;
    const title = titleOfBrowseItem(value);
    return {
      id: ID_PREFIX + nativeId,
      nativeId,
      shortcode: nativeId,
      author: authorOfBrowseItem(value, pageScope),
      desc: title,
      title,
      likes: 0,
      comments: 0,
      views: viewsOfBrowseItem(value),
      durationSec: parseDurationSeconds(value.lengthText || value.thumbnailOverlayTimeStatusRenderer?.text),
      isReel: true,
      cover: str(thumbnailUrlOf(value) || fallbackThumbnailUrl(nativeId)),
      videoUrl: '',
      url: `https://www.youtube.com/shorts/${nativeId}`,
      surface: pageScope?.kind || 'other',
      platform: 'youtube',
      audio: null,
    };
  }

  function mergePartialPosts(prev, next) {
    if (!prev) return next;
    return {
      ...prev,
      ...next,
      likes: Math.max(prev.likes || 0, next.likes || 0),
      comments: Math.max(prev.comments || 0, next.comments || 0),
      views: Math.max(prev.views || 0, next.views || 0),
      author: next.author || prev.author,
      desc: next.desc || prev.desc,
      title: next.title || prev.title,
      cover: next.cover || prev.cover,
      durationSec: next.durationSec || prev.durationSec || 0,
    };
  }

  function harvestBrowse(root, pageScope) {
    const ps = pageScope || { kind: 'other', username: null };
    const byId = new Map();
    const seen = new WeakSet();
    const stack = [root];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (looksLikeBrowseVideo(value)) {
        const post = browseItemToPost(value, ps);
        if (post) byId.set(post.id, mergePartialPosts(byId.get(post.id), post));
        continue;
      }
      if (Array.isArray(value)) for (const item of value) stack.push(item);
      else for (const key in value) stack.push(value[key]);
    }
    return Array.from(byId.values());
  }

  function surfaceFromUrlTag(url, tag) {
    const u = String(url || '');
    if (tag === 'yt-shorts') return 'shorts-feed';
    if (tag === 'yt-player') return 'player';
    if (tag === 'yt-next') return 'next';
    const match = u.match(/\/youtubei\/v1\/(?:reel\/)?([A-Za-z0-9_]+)/);
    return YOUTUBE_ENDPOINT_SURFACES[match?.[1]] || 'unknown';
  }

  globalThis.FeedSorterYouTubeParser = {
    captionTracksOf,
    pickCaptionTrack,
    videoUrlOfPlayer,
    playerToPost,
    parseCaptionsXml,
    parseCaptionsJson3,
    harvestBrowse,
    enrichFromNext,
    surfaceFromUrlTag,
    ID_PREFIX,
  };
})();
