// IIFE mirror of src/lib/transcripts.js for the MV3 service worker
// (importScripts) and content scripts. Keep in lock-step with the ESM spec.
//
// Exposes globalThis.__fsTranscripts = { parseWebVTT, parseJSON3,
// extractAltText, fetchFreeTranscript }.

((root) => {
  const IG_ALT_PREFIX_RE =
    /^\s*(?:photo|image|video|reel)\s+by\s+[^.]+\.\s*may\s+be\s+an?\s+(?:image|photo|video)\s+of[:.]?\s*/i;

  function parseWebVTT(text) {
    if (typeof text !== "string" || !text) return "";
    const src = text.replace(/\r\n?/g, "\n");
    const blocks = src.split(/\n{2,}/);
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      if (i === 0 && /^WEBVTT\b/i.test(lines[0])) continue;
      if (/^NOTE\b/i.test(lines[0])) continue;
      let cueLines = lines;
      if (cueLines.length >= 2 && !cueLines[0].includes("-->") && cueLines[1].includes("-->")) {
        cueLines = cueLines.slice(1);
      }
      cueLines = cueLines.filter((l) => !l.includes("-->"));
      if (!cueLines.length) continue;
      out.push(cueLines.join(" "));
    }
    let body = out.join(" ");
    body = body.replace(/<v\b[^>]*>/gi, "").replace(/<\/v>/gi, "");
    body = body.replace(/<[^>]+>/g, "");
    return body.replace(/\s+/g, " ").trim();
  }

  function parseJSON3(text) {
    if (typeof text !== "string" || !text) return "";
    let obj;
    try { obj = JSON.parse(text); } catch { return ""; }
    const events = Array.isArray(obj?.events) ? obj.events : [];
    const pieces = [];
    let prev = null;
    for (const ev of events) {
      const segs = Array.isArray(ev?.segs) ? ev.segs : [];
      if (!segs.length) continue;
      const joined = segs
        .map((s) => (typeof (s?.utf8) === "string" ? s.utf8 : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!joined) continue;
      if (joined === prev) continue;
      pieces.push(joined);
      prev = joined;
    }
    return pieces.join(" ").replace(/\s+/g, " ").trim();
  }

  function extractAltText(post) {
    const raw = typeof (post?.altText) === "string" ? post.altText : "";
    if (!raw) return { text: "", kind: "alt" };
    const text = raw.replace(IG_ALT_PREFIX_RE, "").replace(/\s+/g, " ").trim();
    return { text, kind: "alt" };
  }

  function pickCaptionTrack(tracks, preferredLang) {
    const lang = preferredLang || "en";
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const pref = (value) => (track) => String((track?.languageCode) || "").toLowerCase().indexOf(String(value || "").toLowerCase()) === 0;
    const nonAsr = tracks.filter((track) => String((track?.kind) || "") !== "asr");
    return nonAsr.find(pref(lang)) || tracks.find(pref(lang)) || nonAsr[0] || tracks[0];
  }

  function appendJson3Format(url) {
    const raw = String(url || "");
    if (!raw || /(?:[?&])fmt=/i.test(raw)) return raw;
    return `${raw + (raw.indexOf("?") >= 0 ? "&" : "?")}fmt=json3`;
  }

  async function fetchCaptionBody(url, fetchImpl, signal) {
    if (!url || typeof fetchImpl !== "function") return "";
    try {
      const res = await fetchImpl(url, { signal, credentials: "include" });
      if (!res || !res.ok) return "";
      return await res.text();
    } catch {
      return "";
    }
  }

  function parseCaptionBody(body, formatHint) {
    const src = String(body || "").trim();
    if (!src) return "";
    const fmt = String(formatHint || "").toLowerCase();
    if (fmt === "json3" || fmt === "json" || src.charAt(0) === "{") {
      const parsed = parseJSON3(src);
      if (parsed) return parsed;
    }
    return parseWebVTT(src);
  }

  async function fetchFreeTranscript(post, opts) {
    const { fetchImpl, signal, preferredLang = "en" } = opts || {};
    if (!post || typeof post !== "object") return null;

    if (typeof post.captionUrl === "string" && post.captionUrl) {
      const body = await fetchCaptionBody(post.captionUrl, fetchImpl, signal);
      const text = parseCaptionBody(body, post.captionFormat || "");
      if (!text) return null;
      return { text, kind: "subtitle", source: "tiktok-vtt" };
    }

    const track = pickCaptionTrack(post.captionTracks, preferredLang);
    if (track?.baseUrl) {
      const body = await fetchCaptionBody(appendJson3Format(track.baseUrl), fetchImpl, signal);
      const text = parseCaptionBody(body, "json3");
      if (!text) return null;
      return {
        text,
        kind: "subtitle",
        source: "youtube-captions",
        language: track.languageCode || "",
      };
    }

    if (typeof post.altText === "string" && post.altText) {
      const { text } = extractAltText(post);
      if (!text) return null;
      return { text, kind: "alt", source: "ig-alt" };
    }

    return null;
  }

  root.__fsTranscripts = { parseWebVTT, parseJSON3, extractAltText, fetchFreeTranscript };
})(typeof self !== "undefined" ? self : this);
