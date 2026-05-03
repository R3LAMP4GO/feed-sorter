// Launches Chromium with the unpacked extension loaded, navigates to an
// Instagram profile, and tails the [FS] logs from the content script.
//
// Usage:
//   node playwright-test.mjs                       # opens about:blank, you drive
//   node playwright-test.mjs zachking              # navigate to that profile
//   node playwright-test.mjs zachking reels 1y     # also exercise filters
//
// First run: you'll need to sign in to Instagram in the launched browser.
// The session is stored in ./.pw-profile/ and reused on subsequent runs.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = __dirname;

const [, , username, surface = "all", range = "all", limit = "0"] = process.argv;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[pw ${ts()}]`, ...a);

// Brave mode: BRAVE=1 BRAVE_PROFILE='Profile 2' node playwright-test.mjs ...
// Uses your real Brave install + the named profile (where you're already
// logged in). Brave MUST be fully quit first (Cmd+Q) — you can't open the
// same user-data-dir twice.
const USE_BRAVE = process.env.BRAVE === "1";
const BRAVE_BIN = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const BRAVE_USER_DATA = path.join(
  process.env.HOME,
  "Library/Application Support/BraveSoftware/Brave-Browser"
);
const BRAVE_PROFILE = process.env.BRAVE_PROFILE || "Profile 2";

const PROFILE_DIR = USE_BRAVE
  ? BRAVE_USER_DATA
  : path.join(__dirname, ".pw-profile");
if (!USE_BRAVE) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const launchOpts = {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(USE_BRAVE ? [`--profile-directory=${BRAVE_PROFILE}`] : []),
  ],
};
if (USE_BRAVE) {
  if (!fs.existsSync(BRAVE_BIN)) {
    console.error("Brave not found at", BRAVE_BIN);
    process.exit(1);
  }
  launchOpts.executablePath = BRAVE_BIN;
  log("using Brave — profile:", BRAVE_PROFILE);
  log("reminder: Brave must be fully quit (Cmd+Q) before this runs.");
} else {
  launchOpts.channel = "chromium";
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

log("launched. extension dir:", EXT_PATH);
log("profile dir:", PROFILE_DIR);

// Track last-kicked URL per page so we re-kick on SPA navigations to a
// new profile/explore page.
const lastKicked = new WeakMap();

// Profile pages: /{username}/  or  /{username}/reels/
// Explore:       /explore/...
// Anything else (home, /p/, /reel/, /direct, /accounts) is skipped.
const KICK_RE = /^https:\/\/www\.instagram\.com\/(?:[\w.][\w.]*[\w]\/(?:reels\/?)?$|explore\/)/;

const kickCollect = async (p) => {
  try {
    const ok = await p.evaluate(async () => {
      // window.fs is exposed by injected.js into the page world.
      for (let i = 0; i < 40 && !window.fs?.collect; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!window.fs?.collect) return "no-api";
      window.fs.collect();
      return "started";
    });
    log("auto-collect:", ok, p.url());
  } catch (e) {
    log("auto-collect failed:", e.message);
  }
};

// Attach console + auto-collect to EVERY page (existing + future tabs).
const attach = (p) => {
  p.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[FS]")) {
      const host = (() => { try { return new URL(p.url()).host; } catch { return ""; } })();
      console.log(`[fs ${ts()}] ${host}`, text.slice(5));
    }
  });
  p.on("pageerror", (err) =>
    console.error(`[pw ${ts()}] pageerror:`, err.message)
  );
  // Whenever this page lands on an IG profile/explore, auto-kick collect.
  // No auto-collect on nav — user must click "Collect all" in the overlay.
  void lastKicked;
};
ctx.pages().forEach(attach);
ctx.on("page", attach);

// Kick collect on any IG page already loaded at startup.
// No auto-kick on existing pages either.
void KICK_RE;
void kickCollect;

const page = ctx.pages()[0] || (await ctx.newPage());

if (username) {
  const url = `https://www.instagram.com/${username}/${
    surface === "reels" ? "reels/" : ""
  }`;
  log("navigating to", url);
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => {
    log("nav error (continuing):", e.message);
  });
} else {
  log("no username arg \u2014 leaving on about:blank, drive the browser yourself.");
}

// Probe whether the overlay booted; if logged-out IG redirects to /accounts/login,
// it will. We retry for ~30s, then nudge the user.
const waitForOverlay = async () => {
  for (let i = 0; i < 30; i++) {
    const ok = await page.evaluate(() => !!window.__feedSorter).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

const overlayUp = await waitForOverlay();
if (!overlayUp) {
  log(
    "overlay not detected. If IG redirected you to /accounts/login, sign in,",
    "then re-run this script. The persistent profile will keep the session."
  );
} else {
  log("overlay booted.");

  if (surface !== "all" || range !== "all" || Number(limit) > 0) {
    log("applying filters", { surface, range, limit });
    await page.evaluate(
      ([surface, range, limit]) => {
        // simulate change events on the overlay's selects so all listeners fire
        const fire = (key, value) => {
          const sel = document.querySelector(`.fs-root [data-ctl="${key}"]`);
          if (!sel) return false;
          sel.value = value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        fire("surface", surface);
        fire("range", range);
        fire("limit", String(limit));
      },
      [surface, range, limit]
    );
  }
}

log("tailing logs. Ctrl+C to quit.");

// Periodic heartbeat: prints captured-post count from any IG tab so you
// can see progress even if no new console line fires.
setInterval(async () => {
  for (const p of ctx.pages()) {
    const url = p.url();
    if (!/instagram\.com/.test(url)) continue;
    const stats = await p.evaluate(async () => {
      if (!window.fs) return null;
      const posts = await window.fs.posts();
      const bySurface = posts.reduce((a, p) => ((a[p.surface] = (a[p.surface] || 0) + 1), a), {});
      const last = window.fs.logs().slice(-1)[0];
      return { total: posts.length, bySurface, lastEvent: last?.event || null };
    }).catch(() => null);
    if (stats) console.log(`[hb ${ts()}]`, stats);
  }
}, 5000);

await new Promise(() => {});
