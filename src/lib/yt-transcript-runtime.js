// YouTube caption-track free-transcript path. Given a captionTrack
// (`{ baseUrl, languageCode, kind }`), fetches the transcript with the
// active session, parses XML/JSON3 to plain text + segments, and posts to
// the managed backend as `source: 'youtube-captions'`.
//
// Wired to background SW via `cmd: 'api.transcribe-text'`.
//
// Exposes window.FeedSorterYouTubeTranscript.

(() => {
  function pickLang(tracks, preferred) {
    preferred = preferred || 'en';
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const has = (lang) => (t) => (t.languageCode || '').toLowerCase().indexOf(lang.toLowerCase()) === 0;
    const nonAsr = tracks.filter((t) => t.kind !== 'asr');
    return nonAsr.find(has(preferred)) || tracks.find(has(preferred)) || nonAsr[0] || tracks[0];
  }

  // Fetch a caption track URL with `fmt=json3` (preferred) and parse with
  // FeedSorterYouTubeParser.parseCaptionsJson3 / parseCaptionsXml.
  async function fetchAndParse(track) {
    if (!track || !track.baseUrl) return null;
    const url = track.baseUrl + (track.baseUrl.indexOf('fmt=') === -1 ? '&fmt=json3' : '');
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`caption fetch ${res.status}`);
    const text = await res.text();
    const Parser = globalThis.FeedSorterYouTubeParser;
    if (!Parser) throw new Error('parser-runtime missing');
    if (text.trim().charAt(0) === '{') {
      try {
        return Parser.parseCaptionsJson3(JSON.parse(text));
      } catch (_) {
        // fall through to XML
      }
    }
    return Parser.parseCaptionsXml(text);
  }

  async function uploadCaptionTranscript(postId, parsed, languageCode) {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'fs-bg',
          cmd: 'api.transcribe-text',
          postId,
          text: parsed.fullText,
          source: 'youtube-captions',
          language: languageCode || null,
          segments: parsed.segments,
          durationS: parsed.segments.length ? parsed.segments[parsed.segments.length - 1].end : null,
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error((resp?.err) || 'upload-failed'));
          resolve(resp);
        },
      );
    });
  }

  globalThis.FeedSorterYouTubeTranscript = { pickLang, fetchAndParse, uploadCaptionTranscript };
})();
