// Free TikTok transcript fetcher. Mirrors `yt_dlp/extractor/tiktok.py`
// `_extract_subtitles_or_create_subtitles_json` — TikTok ships ASR captions
// with every reel under `video.subtitleInfos[].Url`. Format is one of
// `webvtt`, `srt`, or `creator_caption` JSON.
//
// Parser already extracts `{captionUrl, captionFormat, captionSource, captionLang}`
// (see src/lib/parser-tiktok.js `captionsOf`) and stores it on each post.
//
// This runtime fetches the URL with the active session, parses to plain
// text + segments, and posts to the backend via `cmd: 'api.transcribe-text'`
// with `source: 'tiktok-captions'`.
//
// Exposes window.FeedSorterTikTokTranscript.

(function () {
  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); });
  }

  // VTT: lines like
  //   WEBVTT
  //
  //   00:00:00.000 --> 00:00:02.500
  //   Hello world
  function parseVtt(text) {
    const segments = [];
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let cur = null;
    for (const ln of lines) {
      const cue = ln.match(/^(\d{2}:\d{2}:\d{2}\.\d+|\d{2}:\d{2}\.\d+)\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d+|\d{2}:\d{2}\.\d+)/);
      if (cue) {
        if (cur) segments.push(cur);
        cur = { start: tsToS(cue[1]), end: tsToS(cue[2]), text: '' };
        continue;
      }
      if (cur && ln.trim() && !/^WEBVTT/i.test(ln) && !/^NOTE\b/i.test(ln) && !/^\d+$/.test(ln.trim())) {
        cur.text = (cur.text + ' ' + decodeXmlEntities(ln).replace(/<[^>]+>/g, '')).trim();
      } else if (cur && !ln.trim()) {
        if (cur.text) { segments.push(cur); cur = null; }
      }
    }
    if (cur && cur.text) segments.push(cur);
    return { fullText: segments.map((s) => s.text).join(' ').trim(), segments };
  }

  // SRT: same as VTT but timestamps use `,` instead of `.`
  function parseSrt(text) {
    return parseVtt(String(text).replace(/(\d{2}:\d{2}:\d{2}),(\d+)/g, '$1.$2'));
  }

  // creator_caption JSON: TikTok's own format.
  //   { utterances: [{ start_time, end_time, text }] } (ms)
  function parseCreatorCaptionJson(json) {
    const utts = (json && (json.utterances || json.subtitles)) || [];
    const segments = [];
    for (const u of utts) {
      const start = (Number(u.start_time) || 0) / 1000;
      const end = (Number(u.end_time) || 0) / 1000;
      const text = String(u.text || '').trim();
      if (text) segments.push({ start, end, text });
    }
    return { fullText: segments.map((s) => s.text).join(' ').trim(), segments };
  }

  function tsToS(ts) {
    const parts = String(ts).split(':');
    let s = 0;
    for (const p of parts) s = s * 60 + parseFloat(p);
    return s;
  }

  // Pick the best track. Prefer human-uploaded ('whisper' = ASR; non-empty
  // Source = creator) in preferredLang, then ASR, then anything.
  function pickBest(infos, preferredLang) {
    preferredLang = preferredLang || 'en';
    if (!Array.isArray(infos) || !infos.length) return null;
    const langMatches = (info) => String(info.LanguageCodeName || info.captionLang || '').toLowerCase().indexOf(preferredLang.toLowerCase()) === 0;
    const isAsr = (info) => /asr|whisper|mt/i.test(String(info.Source || info.captionSource || ''));
    const human = infos.filter((i) => !isAsr(i));
    return human.find(langMatches) || infos.find(langMatches) || human[0] || infos[0];
  }

  async function fetchAndParse(track) {
    const url = track && (track.captionUrl || track.Url);
    const fmt = String((track && (track.captionFormat || track.Format)) || '').toLowerCase();
    if (!url) return null;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('tt caption fetch ' + res.status);
    const text = await res.text();
    if (fmt === 'webvtt' || fmt === 'vtt' || /^WEBVTT/i.test(text.trim())) return parseVtt(text);
    if (fmt === 'srt') return parseSrt(text);
    // creator_caption (JSON)
    if (fmt.indexOf('json') !== -1 || text.trim().charAt(0) === '{') {
      try { return parseCreatorCaptionJson(JSON.parse(text)); } catch (_) {}
    }
    // Best-effort fallback
    return parseVtt(text);
  }

  async function uploadCaptionTranscript(postId, parsed, languageCode) {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'fs-bg',
          cmd: 'api.transcribe-text',
          postId,
          text: parsed.fullText,
          source: 'tiktok-captions',
          language: languageCode || null,
          segments: parsed.segments,
          durationS: parsed.segments.length ? parsed.segments[parsed.segments.length - 1].end : null,
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error((resp && resp.err) || 'upload-failed'));
          resolve(resp);
        },
      );
    });
  }

  globalThis.FeedSorterTikTokTranscript = {
    pickBest,
    fetchAndParse,
    uploadCaptionTranscript,
    parseVtt,
    parseSrt,
    parseCreatorCaptionJson,
  };
})();
