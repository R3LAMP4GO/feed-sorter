// Free-transcript extraction. Pure ESM. All adapters injected.
//
// Two cheap (no-Whisper) sources of caption-ish text:
//   - TikTok serves WebVTT or JSON3 subtitle URLs alongside posts.
//   - Instagram image posts ship an `accessibility_caption` ("alt text"),
//     which is a description of the image, not a transcript — callers
//     should label the row accordingly (kind: "alt", source: "ig-alt").

const IG_ALT_PREFIX_RE =
  /^\s*(?:photo|image|video|reel)\s+by\s+[^.]+\.\s*may\s+be\s+an?\s+(?:image|photo|video)\s+of[:.]?\s*/i;

/**
 * Strip a WebVTT document down to its plain-text body.
 * Removes:
 *   - WEBVTT signature line (and any header metadata until the first blank)
 *   - NOTE blocks
 *   - cue identifiers (lines before a timing line)
 *   - timing lines (contain "-->")
 *   - voice tags `<v Speaker>...</v>` and other simple HTML-ish tags
 * Returns whitespace-collapsed body text.
 */
export function parseWebVTT(text) {
  if (typeof text !== "string" || !text) return "";
  // Normalise line endings.
  const src = text.replace(/\r\n?/g, "\n");
  const blocks = src.split(/\n{2,}/);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // Skip the WEBVTT signature block (first block starting with WEBVTT).
    if (i === 0 && /^WEBVTT\b/i.test(lines[0])) continue;
    // Skip NOTE blocks.
    if (/^NOTE\b/i.test(lines[0])) continue;
    // Drop cue identifier (first line if next line is a timing line).
    let cueLines = lines;
    if (cueLines.length >= 2 && !cueLines[0].includes("-->") && cueLines[1].includes("-->")) {
      cueLines = cueLines.slice(1);
    }
    // Drop the timing line itself.
    cueLines = cueLines.filter((l) => !l.includes("-->"));
    if (!cueLines.length) continue;
    out.push(cueLines.join(" "));
  }
  let body = out.join(" ");
  // Strip voice tags `<v Speaker>...</v>` while keeping inner text.
  body = body.replace(/<v\b[^>]*>/gi, "").replace(/<\/v>/gi, "");
  // Strip any other simple tags (e.g. <c>, <i>, <b>, <00:00:01.000>).
  body = body.replace(/<[^>]+>/g, "");
  // Collapse whitespace.
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Parse YouTube-style JSON3 timed-text:
 *   { events: [{ tStartMs, segs: [{ utf8 }] }] }
 * Concatenates `segs[].utf8` per event with spaces, dedupes consecutive
 * identical event-strings, returns the joined plain string.
 */
export function parseJSON3(text) {
  if (typeof text !== "string" || !text) return "";
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return "";
  }
  const events = Array.isArray(obj?.events) ? obj.events : [];
  const pieces = [];
  let prev = null;
  for (const ev of events) {
    const segs = Array.isArray(ev?.segs) ? ev.segs : [];
    if (!segs.length) continue;
    const joined = segs
      .map((s) => (typeof s?.utf8 === "string" ? s.utf8 : ""))
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

/**
 * Extract Instagram alt text (`accessibility_caption`) and strip the
 * boilerplate prefix ("Photo by user. May be an image of: ...").
 * Returns `{ text, kind: "alt" }` — the descriptor, not a transcript.
 */
export function extractAltText(post) {
  const raw = typeof post?.altText === "string" ? post.altText : "";
  if (!raw) return { text: "", kind: "alt" };
  const text = raw.replace(IG_ALT_PREFIX_RE, "").replace(/\s+/g, " ").trim();
  return { text, kind: "alt" };
}

/**
 * Cheap-transcript cascade. No network unless captionUrl is set.
 *
 *   1. post.captionUrl present (TikTok) → fetch + parse → subtitle.
 *   2. post.altText present  (IG image) → return descriptor.
 *   3. otherwise              → null    (caller falls back to Whisper).
 */
export async function fetchFreeTranscript(post, opts = {}) {
  const { fetchImpl, signal } = opts;
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
      // Default to WebVTT (TikTok's common format).
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
