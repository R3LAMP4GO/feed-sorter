// IIFE mirror of src/lib/parser-youtube.js for content scripts. Keep in
// lock-step. Exposes window.FeedSorterYouTubeParser.

(function () {
  const ID_PREFIX = 'yt_';
  const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
  const str = (v) => (v == null ? '' : String(v));

  function captionTracksOf(player) {
    const tracks = player && player.captions && player.captions.playerCaptionsTracklistRenderer && player.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map((t) => ({
      baseUrl: str(t && t.baseUrl),
      languageCode: str(t && t.languageCode),
      name: str((t && t.name && t.name.simpleText) || (t && t.name && t.name.runs && t.name.runs[0] && t.name.runs[0].text) || ''),
      kind: str(t && t.kind),
    }));
  }

  function pickCaptionTrack(tracks, preferredLang) {
    preferredLang = preferredLang || 'en';
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const pref = (lang) => (t) => t.languageCode.toLowerCase().indexOf(lang.toLowerCase()) === 0;
    const nonAsr = tracks.filter((t) => t.kind !== 'asr');
    return nonAsr.find(pref(preferredLang)) || tracks.find(pref(preferredLang)) || nonAsr[0] || tracks[0];
  }

  function videoUrlOfPlayer(player) {
    const formats = player && player.streamingData && player.streamingData.formats;
    if (Array.isArray(formats)) {
      const f = formats.find((x) => typeof x.url === 'string' && /video\/mp4/i.test(x.mimeType || ''));
      if (f) return f.url;
    }
    const adaptive = player && player.streamingData && player.streamingData.adaptiveFormats;
    if (Array.isArray(adaptive)) {
      const f = adaptive.find((x) => typeof x.url === 'string' && /video\/mp4/i.test(x.mimeType || ''));
      if (f) return f.url;
    }
    return '';
  }

  function playerToPost(player, pageScope) {
    pageScope = pageScope || { kind: 'other', username: null };
    const vd = (player && player.videoDetails) || {};
    const nativeId = str(vd.videoId);
    if (!nativeId) return null;
    const handle = pageScope.username || str(vd.author).replace(/^@/, '').toLowerCase();
    const thumbs = vd.thumbnail && vd.thumbnail.thumbnails;
    const cover = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : '';
    const surface = pageScope.kind === 'shorts-feed' ? 'shorts-feed' : pageScope.kind;
    return {
      id: ID_PREFIX + nativeId,
      nativeId,
      shortcode: nativeId,
      author: handle,
      channelId: str(vd.channelId),
      desc: str(vd.shortDescription || vd.title || ''),
      title: str(vd.title),
      createTime: 0,
      likes: 0,
      comments: 0,
      views: num(vd.viewCount),
      shares: 0,
      saves: 0,
      durationSec: num(vd.lengthSeconds),
      mediaType: 2,
      isReel: true,
      cover: str(cover),
      videoUrl: videoUrlOfPlayer(player),
      url: 'https://www.youtube.com/shorts/' + nativeId,
      surface,
      platform: 'youtube',
      audio: null,
      captionTracks: captionTracksOf(player),
    };
  }

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); });
  }

  function parseCaptionsXml(xml) {
    const segments = [];
    const tagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    const attrOf = (attrs, name) => {
      const m2 = attrs.match(new RegExp('\\b' + name + '="([^"]+)"'));
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
    const events = json && json.events;
    if (!Array.isArray(events)) return { fullText: '', segments: [] };
    const segments = [];
    for (const ev of events) {
      if (!Array.isArray(ev.segs)) continue;
      const start = (Number(ev.tStartMs) || 0) / 1000;
      const dur = (Number(ev.dDurationMs) || 0) / 1000;
      const text = ev.segs.map((s) => String((s && s.utf8) || '')).join('').trim();
      if (text) segments.push({ start, end: start + dur, text });
    }
    return { fullText: segments.map((s) => s.text).join(' ').trim(), segments };
  }

  function parseLooseNumber(s) {
    const cleaned = String(s == null ? '' : s).replace(/[,\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  // /youtubei/v1/next: walks the deeply-nested response for likeButtonRenderer
  // / viewCount / dateText to fill in metrics that /player doesn't expose.
  // Returns a partial post-shaped object (likes/views/comments/uploadedAt) that
  // ingest's Math.max merger will fold into the existing /player row.
  // Requires at least one digit; allows surrounding/separating commas/dots/whitespace.
  // Without the leading `\d` anchor, the regex would happily match a single space
  // (since `\s` is in the character class) e.g. on labels like
  // "like this video along with 89,432 other people".
  const VIEW_COUNT_RE = /(\d[\d,.\s]*)\s*(views?|view)?/i;
  const LIKE_RE = /(\d[\d,.\s]*)/;

  function enrichFromNext(next) {
    const out = { likes: 0, views: 0, comments: 0, uploadedAt: 0 };
    const stack = [next];
    const seen = new WeakSet();
    while (stack.length) {
      const v = stack.pop();
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);

      const lbr = v.toggleButtonRenderer || v.likeButtonRenderer;
      const label =
        lbr && lbr.defaultText && lbr.defaultText.accessibility &&
        lbr.defaultText.accessibility.accessibilityData &&
        lbr.defaultText.accessibility.accessibilityData.label;
      if (label) {
        const m = String(label).match(LIKE_RE);
        if (m) out.likes = parseLooseNumber(m[1]);
      }
      if (v.viewCount && v.viewCount.simpleText) {
        const m = String(v.viewCount.simpleText).match(VIEW_COUNT_RE);
        if (m) out.views = parseLooseNumber(m[1]);
      }
      if (v.dateText && v.dateText.simpleText) {
        const t = Date.parse(String(v.dateText.simpleText));
        if (Number.isFinite(t)) out.uploadedAt = Math.floor(t / 1000);
      }

      if (Array.isArray(v)) for (const x of v) stack.push(x);
      else for (const k in v) stack.push(v[k]);
    }
    return out;
  }

  // /youtubei/v1/browse: best-effort tree walk that returns one partial post
  // per shorts thumbnail (videoId + title/headline/byline).
  function browseItemToPost(it, pageScope) {
    const nativeId = str(it && it.videoId);
    if (!nativeId) return null;
    const title = str(
      (it && it.title && it.title.simpleText) ||
        (it && it.headline && it.headline.simpleText) ||
        (it && it.title && it.title.runs && it.title.runs[0] && it.title.runs[0].text) ||
        ''
    );
    const thumbs = it && it.thumbnail && it.thumbnail.thumbnails;
    const cover = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : '';
    return {
      id: ID_PREFIX + nativeId,
      nativeId,
      shortcode: nativeId,
      author: (pageScope && pageScope.username) || '',
      desc: title,
      title,
      likes: 0,
      comments: 0,
      views: parseLooseNumber(it && it.viewCountText && it.viewCountText.simpleText),
      durationSec: parseLooseNumber(it && it.lengthText && it.lengthText.simpleText),
      isReel: true,
      cover: str(cover),
      videoUrl: '',
      url: 'https://www.youtube.com/shorts/' + nativeId,
      surface: (pageScope && pageScope.kind) || 'other',
      platform: 'youtube',
      audio: null,
    };
  }

  function harvestBrowse(root, pageScope) {
    const ps = pageScope || { kind: 'other', username: null };
    const found = [];
    const seen = new WeakSet();
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      if (v.videoId && (v.headline || v.title || v.shortBylineText)) {
        found.push(v);
        continue;
      }
      if (Array.isArray(v)) for (const x of v) stack.push(x);
      else for (const k in v) stack.push(v[k]);
    }
    return found.map((it) => browseItemToPost(it, ps)).filter(Boolean);
  }

  function surfaceFromUrlTag(url, tag) {
    const u = String(url || '');
    if (tag === 'yt-shorts' || /\/youtubei\/v1\/browse/.test(u)) return 'shorts-feed';
    if (tag === 'yt-player' || /\/youtubei\/v1\/player/.test(u)) return 'player';
    if (tag === 'yt-next' || /\/youtubei\/v1\/next/.test(u)) return 'next';
    return 'unknown';
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
