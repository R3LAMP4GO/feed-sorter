import { describe, it, expect } from "vitest";
import {
  looksLikeMedia,
  cover,
  captionText,
  author,
  videoUrlOf,
  likesOf,
  commentsOf,
  viewsOf,
  surfaceFromUrlTag,
  toPost,
  harvest,
} from "../../src/lib/parser.js";

describe("looksLikeMedia", () => {
  it("returns true for a v1 feed media object", () => {
    expect(
      looksLikeMedia({ pk: "1", code: "abc", like_count: 10, media_type: 1 })
    ).toBe(true);
  });

  it("returns true for a graphql shape", () => {
    expect(
      looksLikeMedia({
        id: "x",
        shortcode: "y",
        edge_media_preview_like: { count: 5 },
      })
    ).toBe(true);
  });

  it("returns false without an id", () => {
    expect(looksLikeMedia({ code: "abc", like_count: 10, media_type: 1 })).toBe(false);
  });

  it("accepts newer GraphQL timeline nodes that omit public stat keys", () => {
    expect(
      looksLikeMedia({
        id: "x",
        code: "abc",
        __typename: "GraphImage",
        display_url: "https://cdn.example/a.jpg",
        taken_at_timestamp: 1_700_000_000,
      })
    ).toBe(true);
  });

  it("accepts newer GraphQL reel nodes with nested media and no public stat keys", () => {
    const out = harvest(
      {
        data: {
          xdt_api__v1__clips__user__connection_v2: {
            edges: [
              {
                node: {
                  media: {
                    pk: "7001",
                    code: "Reel7001",
                    media_type: 2,
                    product_type: "clips",
                    taken_at: 1_700_000_000,
                    image_versions2: { candidates: [{ url: "https://cdn.example/r.jpg" }] },
                    user: { username: "zachking" },
                  },
                },
              },
            ],
          },
        },
      },
      "reels"
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "7001",
      shortcode: "Reel7001",
      author: "zachking",
      isReel: true,
      surface: "reels",
    });
  });

  it("returns false without stats or media payload", () => {
    expect(looksLikeMedia({ pk: "1", code: "abc", media_type: 1 })).toBe(false);
  });

  it("returns false without a shape key", () => {
    expect(looksLikeMedia({ pk: "1", like_count: 10 })).toBe(false);
  });

  it("returns false on null / non-object", () => {
    expect(looksLikeMedia(null)).toBe(false);
    expect(looksLikeMedia("string")).toBe(false);
    expect(looksLikeMedia(42)).toBe(false);
  });
});

describe("cover", () => {
  it("prefers image_versions2 candidates", () => {
    expect(
      cover({
        image_versions2: { candidates: [{ url: "A" }, { url: "B" }] },
        display_url: "C",
      })
    ).toBe("A");
  });

  it("falls back through display_url, thumbnail_url, thumbnail_src", () => {
    expect(cover({ display_url: "D" })).toBe("D");
    expect(cover({ thumbnail_url: "T" })).toBe("T");
    expect(cover({ thumbnail_src: "S" })).toBe("S");
  });

  it("recurses into the first carousel child", () => {
    expect(
      cover({ carousel_media: [{ display_url: "child0" }, { display_url: "child1" }] })
    ).toBe("child0");
  });

  it("returns empty string when nothing matches", () => {
    expect(cover({})).toBe("");
  });
});

describe("captionText", () => {
  it("handles a string caption", () => {
    expect(captionText({ caption: "hi" })).toBe("hi");
  });

  it("handles an object caption with .text", () => {
    expect(captionText({ caption: { text: "hi2" } })).toBe("hi2");
  });

  it("handles graphql edge_media_to_caption", () => {
    expect(
      captionText({
        edge_media_to_caption: { edges: [{ node: { text: "edge-cap" } }] },
      })
    ).toBe("edge-cap");
  });

  it("returns empty string when no caption shape is present", () => {
    expect(captionText({})).toBe("");
  });
});

describe("author", () => {
  it("walks the fallback chain", () => {
    expect(author({ user: { username: "a" } })).toBe("a");
    expect(author({ owner: { username: "b" } })).toBe("b");
    expect(author({ media: { user: { username: "c" } } })).toBe("c");
    expect(author({ caption: { user: { username: "d" } } })).toBe("d");
    expect(author({})).toBe("");
  });
});

describe("videoUrlOf", () => {
  it("prefers video_versions[0].url", () => {
    expect(
      videoUrlOf({ video_versions: [{ url: "vv" }], video_url: "raw" })
    ).toBe("vv");
  });
  it("falls back to video_url", () => {
    expect(videoUrlOf({ video_url: "raw" })).toBe("raw");
  });
  it("returns empty string when nothing", () => {
    expect(videoUrlOf({})).toBe("");
  });
});

describe("likesOf", () => {
  it("uses like_count first", () => {
    expect(likesOf({ like_count: 7, edge_media_preview_like: { count: 99 } })).toBe(7);
  });
  it("falls back to edge_media_preview_like.count", () => {
    expect(likesOf({ edge_media_preview_like: { count: 12 } })).toBe(12);
  });
  it("falls back to edge_liked_by.count", () => {
    expect(likesOf({ edge_liked_by: { count: 3 } })).toBe(3);
  });
  it("returns 0 when none", () => {
    expect(likesOf({})).toBe(0);
  });
});

describe("commentsOf", () => {
  it("uses comment_count first", () => {
    expect(commentsOf({ comment_count: 4 })).toBe(4);
  });
  it("falls back to edge_media_to_comment.count", () => {
    expect(commentsOf({ edge_media_to_comment: { count: 5 } })).toBe(5);
  });
  it("falls back to edge_media_to_parent_comment.count", () => {
    expect(commentsOf({ edge_media_to_parent_comment: { count: 6 } })).toBe(6);
  });
});

describe("viewsOf", () => {
  it("checks all keys in priority order", () => {
    expect(viewsOf({ play_count: 1 })).toBe(1);
    expect(viewsOf({ ig_play_count: 2 })).toBe(2);
    expect(viewsOf({ view_count: 3 })).toBe(3);
    expect(viewsOf({ video_view_count: 4 })).toBe(4);
    expect(viewsOf({})).toBe(0);
  });
});

describe("surfaceFromUrlTag", () => {
  it("classifies by tag", () => {
    expect(surfaceFromUrlTag("", "ig-clips")).toBe("reels");
    expect(surfaceFromUrlTag("", "ig-explore")).toBe("explore");
    expect(surfaceFromUrlTag("", "ig-feed")).toBe("profile");
    expect(surfaceFromUrlTag("", "ig-graphql")).toBe("graphql");
  });
  it("classifies by URL", () => {
    expect(surfaceFromUrlTag("https://i.instagram.com/api/v1/clips/user/", "")).toBe(
      "reels"
    );
    expect(surfaceFromUrlTag("/api/v1/discover/topical/", "")).toBe("explore");
    expect(surfaceFromUrlTag("/api/v1/feed/user/foo/", "")).toBe("profile");
    expect(surfaceFromUrlTag("/graphql/query/", "")).toBe("graphql");
    expect(surfaceFromUrlTag("/api/graphql", "")).toBe("graphql");
  });
  it("returns 'unknown' otherwise", () => {
    expect(surfaceFromUrlTag("/random", "")).toBe("unknown");
  });
});

describe("toPost", () => {
  it("infers author from pageScope when missing", () => {
    const p = toPost(
      { pk: "1", code: "abc", like_count: 1, media_type: 1 },
      "profile",
      { kind: "profile", username: "zachking" }
    );
    expect(p.author).toBe("zachking");
    expect(p.url).toBe("https://www.instagram.com/p/abc/");
    expect(p.isReel).toBe(false);
  });

  it("marks as reel for media_type=2", () => {
    const p = toPost(
      { pk: "2", code: "rrr", like_count: 1, media_type: 2 },
      "profile"
    );
    expect(p.isReel).toBe(true);
    expect(p.url).toBe("https://www.instagram.com/reel/rrr/");
  });

  it("marks as reel when surface is reels", () => {
    const p = toPost({ pk: "3", code: "z", like_count: 1, media_type: 1 }, "reels");
    expect(p.isReel).toBe(true);
  });
});

describe("harvest", () => {
  it("walks nested shapes and extracts media", () => {
    const root = {
      items: [
        { pk: "1", code: "a", like_count: 5, media_type: 1, user: { username: "x" } },
        { pk: "2", code: "b", like_count: 6, media_type: 2, user: { username: "x" } },
      ],
    };
    const out = harvest(root, "profile");
    expect(out).toHaveLength(2);
    expect(out[0].author).toBe("x");
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(["1", "2"]));
  });

  it("unwraps {node: media} edges", () => {
    const root = {
      edges: [
        {
          node: {
            id: "g1",
            shortcode: "sc",
            edge_media_preview_like: { count: 2 },
            edge_media_to_caption: { edges: [{ node: { text: "yo" } }] },
          },
        },
      ],
    };
    const out = harvest(root, "explore");
    expect(out).toHaveLength(1);
    expect(out[0].desc).toBe("yo");
    expect(out[0].likes).toBe(2);
  });
});
