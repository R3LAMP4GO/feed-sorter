// IIFE mirror of src/lib/transcripts.js for the MV3 service worker
// (importScripts) and content scripts. Keep in lock-step with the ESM spec.
//
// Exposes globalThis.__fsTranscripts = { parseWebVTT, parseJSON3,
// extractAltText, fetchFreeTranscript }.

(function (root) {
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
    const events = Array.isArray(obj && obj.events) ? obj.events : [];
    const pieces = [];
    let prev = null;
    for (const ev of events) {
      const segs = Array.isArray(ev && ev.segs) ? ev.segs : [];
      if (!segs.length) continue;
      const joined = segs
        .map((s) => (typeof (s && s.utf8) === "string" ? s.utf8 : ""))
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
    const raw = typeof (post && post.altText) === "string" ? post.altText : "";
    if (!raw) return { text: "", kind: "alt" };
    const text = raw.replace(IG_ALT_PREFIX_RE, "").replace(/\s+/g, " ").trim();
    return { text, kind: "alt" };
  }

  async function fetchFreeTranscript(post, opts) {
    const { fetchImpl, signal } = opts || {};
    if (!post || typeof post !== "object") return null;

    if (typeof post.captionUrl === "string" && post.captionUrl) {
      if (typeof fetchImpl !== "function") return null;
      let body = "";
      try {
        const res = await fetchImpl(post.captionUrl, { signal });
        if (!res || !res.ok) return null;
        body = await res.text();
      } catch {
        return null;
      }
      const fmt = (post.captionFormat || "").toLowerCase();
      let text = "";
      if (fmt === "json3" || fmt === "json") {
        text = parseJSON3(body);
      } else {
        text = parseWebVTT(body);
      }
      if (!text) return null;
      return { text, kind: "subtitle", source: "tiktok-vtt" };
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
