// Unit tests for src/lib/profile-parser.js — IG + TT profile parsing,
// niche-text builder, URL matchers. The IIFE runtime mirror is verified at
// the end by running the same canonical inputs through both copies and
// asserting parity (catches lock-step drift).

import { describe, it, expect, beforeAll } from "vitest";
import {
  parseInstagramProfile,
  parseTikTokProfile,
  parseProfile,
  isInstagramProfileInfoUrl,
  isTikTokProfileInfoUrl,
  profileToNicheText,
  nicheTextWordCount,
} from "../../src/lib/profile-parser.js";

// ---------- Instagram fixtures ----------
const igRealtor = {
  data: {
    user: {
      username: "Sarah.Realtor",
      full_name: "Sarah Chen | Bay Area Realtor®",
      biography: "Helping families find their dream home in SF & Peninsula ⭐\nDRE# 02105432\nfree-buyer-guide ↓",
      category_name: "Real Estate Agent",
      external_url: "https://www.sarahchenhomes.com/",
      edge_followed_by: { count: 12400 },
      is_business_account: true,
    },
  },
  status: "ok",
};

const igMinimal = {
  // Older /users/<id>/info/ flat shape.
  user: {
    username: "minimal_creator",
    full_name: "",
    biography: "",
    external_url: "",
  },
};

const igEmpty = { data: { user: null } };

// ---------- TikTok fixtures ----------
const ttCoach = {
  userInfo: {
    user: {
      uniqueId: "FitCoachMike",
      nickname: "Mike — Strength Coach",
      signature: "Online strength coaching for busy guys 💪\n10k+ clients · DM CHALLENGE",
      bioLink: { link: "https://strongermike.fit/start" },
    },
    stats: { followerCount: 84200, followingCount: 312 },
  },
};

const ttWebRehydrate = {
  __DEFAULT_SCOPE__: {
    "webapp.user-detail": {
      userInfo: {
        user: {
          uniqueId: "edutok",
          nickname: "EduTok",
          signature: "We teach hard things easily",
          bioLink: null,
        },
        stats: { followerCount: 22000 },
      },
    },
  },
};

describe("parseInstagramProfile", () => {
  it("extracts bio + category + external_url + full_name from web_profile_info", () => {
    const p = parseInstagramProfile(igRealtor);
    expect(p).toEqual({
      platform: "instagram",
      username: "sarah.realtor", // normalized to lowercase
      fullName: "Sarah Chen | Bay Area Realtor®",
      bio: "Helping families find their dream home in SF & Peninsula ⭐ DRE# 02105432 free-buyer-guide ↓",
      category: "Real Estate Agent",
      externalUrl: "https://www.sarahchenhomes.com/",
      followerCount: 12400,
      isBusiness: true,
    });
  });

  it("handles the flat /users/<id>/info/ shape with empty fields", () => {
    const p = parseInstagramProfile(igMinimal);
    expect(p).toEqual({
      platform: "instagram",
      username: "minimal_creator",
      fullName: "",
      bio: "",
      category: "",
      externalUrl: "",
      followerCount: null,
      isBusiness: null,
    });
  });

  it("returns null on empty / non-user payloads", () => {
    expect(parseInstagramProfile(igEmpty)).toBeNull();
    expect(parseInstagramProfile(null)).toBeNull();
    expect(parseInstagramProfile({ data: {} })).toBeNull();
    expect(parseInstagramProfile({})).toBeNull();
  });

  it("falls back to business_category_name when category_name is empty", () => {
    const p = parseInstagramProfile({
      data: {
        user: {
          username: "biz",
          biography: "x",
          full_name: "",
          category_name: "",
          business_category_name: "Personal Goods & General Merchandise Stores",
        },
      },
    });
    expect(p.category).toBe("Personal Goods & General Merchandise Stores");
  });

  it("falls back to bio_links[0].url when external_url is empty", () => {
    const p = parseInstagramProfile({
      data: {
        user: {
          username: "c",
          biography: "x",
          full_name: "",
          external_url: "",
          bio_links: [{ url: "https://example.com/me" }],
        },
      },
    });
    expect(p.externalUrl).toBe("https://example.com/me");
  });

  it("caps stupendously long bios to 500 chars (defensive)", () => {
    const long = "x".repeat(2000);
    const p = parseInstagramProfile({
      data: { user: { username: "u", biography: long, full_name: "" } },
    });
    expect(p.bio.length).toBe(500);
  });

  it("normalizes whitespace in bio (collapses newlines + multispace)", () => {
    const p = parseInstagramProfile({
      data: {
        user: {
          username: "u",
          biography: "line one\n\n\nline   two\tline three",
          full_name: "",
        },
      },
    });
    expect(p.bio).toBe("line one line two line three");
  });
});

describe("parseTikTokProfile", () => {
  it("extracts signature + bioLink + nickname from /api/user/detail/", () => {
    const p = parseTikTokProfile(ttCoach);
    expect(p).toEqual({
      platform: "tiktok",
      username: "fitcoachmike",
      fullName: "Mike — Strength Coach",
      bio: "Online strength coaching for busy guys 💪 10k+ clients · DM CHALLENGE",
      category: "",
      externalUrl: "https://strongermike.fit/start",
      followerCount: 84200,
      isBusiness: null,
    });
  });

  it("handles __UNIVERSAL_DATA_FOR_REHYDRATION__ shape (web-rehydration)", () => {
    const p = parseTikTokProfile(ttWebRehydrate);
    expect(p).not.toBeNull();
    expect(p.username).toBe("edutok");
    expect(p.bio).toBe("We teach hard things easily");
    expect(p.followerCount).toBe(22000);
    expect(p.externalUrl).toBe("");
  });

  it("returns null on payloads without userInfo.user", () => {
    expect(parseTikTokProfile({ userInfo: {} })).toBeNull();
    expect(parseTikTokProfile(null)).toBeNull();
    expect(parseTikTokProfile({})).toBeNull();
  });
});

describe("URL matchers", () => {
  it("isInstagramProfileInfoUrl recognizes the two canonical endpoints", () => {
    expect(isInstagramProfileInfoUrl("https://www.instagram.com/api/v1/users/web_profile_info/?username=foo"))
      .toBe(true);
    expect(isInstagramProfileInfoUrl("https://i.instagram.com/api/v1/users/12345678/info/"))
      .toBe(true);
    expect(isInstagramProfileInfoUrl("https://www.instagram.com/api/v1/feed/user/123/")).toBe(false);
    expect(isInstagramProfileInfoUrl("")).toBe(false);
    expect(isInstagramProfileInfoUrl(null)).toBe(false);
  });

  it("isTikTokProfileInfoUrl matches /api/user/detail/", () => {
    expect(isTikTokProfileInfoUrl("https://www.tiktok.com/api/user/detail/?secUid=abc")).toBe(true);
    expect(isTikTokProfileInfoUrl("https://www.tiktok.com/api/post/item_list/?secUid=abc")).toBe(false);
  });
});

describe("parseProfile (multi-platform dispatch)", () => {
  it("routes to IG parser when hintUrl is web_profile_info", () => {
    const p = parseProfile(igRealtor, "https://www.instagram.com/api/v1/users/web_profile_info/?username=foo");
    expect(p.platform).toBe("instagram");
    expect(p.category).toBe("Real Estate Agent");
  });

  it("routes to TT parser when hintUrl is user/detail", () => {
    const p = parseProfile(ttCoach, "https://www.tiktok.com/api/user/detail/?secUid=abc");
    expect(p.platform).toBe("tiktok");
    expect(p.username).toBe("fitcoachmike");
  });

  it("falls back to platform sniffing when hintUrl is missing", () => {
    expect(parseProfile(igRealtor).platform).toBe("instagram");
    expect(parseProfile(ttCoach).platform).toBe("tiktok");
  });
});

describe("profileToNicheText", () => {
  it("concatenates category + fullName + bio + URL host with bullets", () => {
    const txt = profileToNicheText({
      category: "Real Estate Agent",
      fullName: "Sarah Chen",
      bio: "Helping families find homes",
      externalUrl: "https://www.sarahchenhomes.com/path",
    });
    expect(txt).toBe("Real Estate Agent • Sarah Chen • Helping families find homes • sarahchenhomes.com");
  });

  it("skips empty fields gracefully", () => {
    expect(profileToNicheText({ bio: "fitness coach" })).toBe("fitness coach");
    expect(profileToNicheText({})).toBe("");
    expect(profileToNicheText(null)).toBe("");
  });

  it("drops un-parseable URLs silently", () => {
    const txt = profileToNicheText({ bio: "x", externalUrl: "not a url" });
    expect(txt).toBe("x");
  });
});

describe("nicheTextWordCount", () => {
  it("counts meaningful alnum tokens of length ≥3", () => {
    // 'real','estate','agent' count; 'in' and 'SF' are <3 chars so skipped.
    expect(nicheTextWordCount("real estate agent in SF")).toBe(3);
    // Longer string for sanity.
    expect(nicheTextWordCount("Real Estate Agent helping families find homes")).toBe(7);
    expect(nicheTextWordCount("")).toBe(0);
    expect(nicheTextWordCount(null)).toBe(0);
  });
});

describe("IIFE runtime mirror parity", () => {
  let R;
  beforeAll(async () => {
    await import("../../src/lib/profile-parser-runtime.js");
    R = globalThis.__fsProfileParser;
  });

  it("parses IG identically", () => {
    expect(R.parseInstagramProfile(igRealtor))
      .toEqual(parseInstagramProfile(igRealtor));
  });

  it("parses TT identically", () => {
    expect(R.parseTikTokProfile(ttCoach))
      .toEqual(parseTikTokProfile(ttCoach));
  });

  it("dispatches identically", () => {
    expect(R.parseProfile(igRealtor, "/api/v1/users/web_profile_info/"))
      .toEqual(parseProfile(igRealtor, "/api/v1/users/web_profile_info/"));
  });

  it("builds niche text identically", () => {
    const arg = { category: "x", bio: "y", externalUrl: "https://z.com/" };
    expect(R.profileToNicheText(arg)).toBe(profileToNicheText(arg));
  });
});
