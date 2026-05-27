// Pure parsing helpers for Instagram media JSON.
// No DOM, no chrome APIs, no global state — safe to import from tests
// and from the content script alike.

export const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

export const looksLikeMedia = (o) => {
  if (!o || typeof o !== "object") return false;
  const hasId = o.pk != null || o.id != null;
  if (!hasId) return false;
  const hasStat =
    "like_count" in o ||
    "play_count" in o ||
    "comment_count" in o ||
    "view_count" in o ||
    "ig_play_count" in o ||
    "edge_media_preview_like" in o ||
    "edge_liked_by" in o;
  const hasShape =
    "code" in o || "shortcode" in o || "media_type" in o || "carousel_media" in o;
  const hasMediaPayload =
    "taken_at" in o ||
    "taken_at_timestamp" in o ||
    "display_url" in o ||
    "thumbnail_url" in o ||
    "thumbnail_src" in o ||
    "video_versions" in o ||
    "video_url" in o ||
    "image_versions2" in o ||
    (Array.isArray(o.carousel_media) && o.carousel_media.length > 0) ||
    /^Graph(Image|Video|Sidecar)$/.test(String(o.__typename || ""));
  return hasShape && (hasStat || hasMediaPayload);
};

export const cover = (m) => {
  const v2 =
    m.image_versions2?.candidates?.[0]?.url ||
    m.image_versions?.candidates?.[0]?.url;
  if (v2) return v2;
  if (m.display_url) return m.display_url;
  if (m.thumbnail_url) return m.thumbnail_url;
  if (m.thumbnail_src) return m.thumbnail_src;
  if (m.carousel_media?.[0]) return cover(m.carousel_media[0]);
  return "";
};

export const captionText = (m) => {
  if (typeof m.caption === "string") return m.caption;
  if (m.caption?.text) return m.caption.text;
  if (m.edge_media_to_caption?.edges?.[0]?.node?.text)
    return m.edge_media_to_caption.edges[0].node.text;
  return "";
};

export const author = (m) =>
  m.user?.username ||
  m.owner?.username ||
  m.user?.user?.username ||
  m.media?.user?.username ||
  m.caption?.user?.username ||
  "";

export const videoUrlOf = (m) => {
  if (m.video_versions?.[0]?.url) return m.video_versions[0].url;
  if (typeof m.video_url === "string") return m.video_url;
  return "";
};

export const likesOf = (m) => {
  if (typeof m.like_count === "number") return m.like_count;
  if (m.edge_media_preview_like?.count != null)
    return num(m.edge_media_preview_like.count);
  if (m.edge_liked_by?.count != null) return num(m.edge_liked_by.count);
  return 0;
};

export const commentsOf = (m) => {
  if (typeof m.comment_count === "number") return m.comment_count;
  if (m.edge_media_to_comment?.count != null)
    return num(m.edge_media_to_comment.count);
  if (m.edge_media_to_parent_comment?.count != null)
    return num(m.edge_media_to_parent_comment.count);
  return 0;
};

export const viewsOf = (m) => {
  return num(
    m.play_count ?? m.ig_play_count ?? m.view_count ?? m.video_view_count
  );
};

export const surfaceFromUrlTag = (url, tag) => {
  if (tag === "ig-clips" || /\/clips\/user\//.test(url)) return "reels";
  if (tag === "ig-explore" || /\/discover\//.test(url)) return "explore";
  if (tag === "ig-feed" || /\/feed\/user\//.test(url)) return "profile";
  if (tag === "ig-graphql" || /\/(?:api\/graphql|graphql\/)/.test(url)) return "graphql";
  return "unknown";
};

// `pageScope` is passed in so this remains pure & testable.
export const toPost = (m, surface, pageScope = { kind: "other", username: null }) => {
  const id = String(m.pk ?? m.id);
  const shortcode = m.code || m.shortcode || "";
  const isReel =
    m.product_type === "clips" || m.media_type === 2 || surface === "reels";
  let a = author(m);
  if (!a && pageScope.kind === "profile" && pageScope.username) {
    a = pageScope.username;
  }
  return {
    id,
    shortcode,
    author: a,
    desc: captionText(m),
    createTime: num(m.taken_at ?? m.taken_at_timestamp),
    likes: likesOf(m),
    comments: commentsOf(m),
    views: viewsOf(m),
    mediaType: num(m.media_type),
    isReel,
    cover: cover(m),
    videoUrl: videoUrlOf(m),
    url: shortcode
      ? `https://www.instagram.com/${isReel ? "reel" : "p"}/${shortcode}/`
      : "",
    surface,
    platform: "instagram",
    nativeId: id,
  };
};

export const harvest = (root, surface, pageScope) => {
  const found = [];
  const seen = new WeakSet();
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (looksLikeMedia(v)) {
      found.push(v);
      continue;
    }
    if (v.node && looksLikeMedia(v.node)) {
      found.push(v.node);
      continue;
    }
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else {
      for (const k in v) stack.push(v[k]);
    }
  }
  return found.map((m) => toPost(m, surface, pageScope));
};
