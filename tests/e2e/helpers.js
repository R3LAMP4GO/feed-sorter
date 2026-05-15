// Helpers for launching a Chromium context with the extension loaded
// against a localhost stub instead of www.instagram.com.
import { chromium } from "@playwright/test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Files (relative to repo root) that need to be present in the temp extension dir.
const EXTENSION_FILES = [
  "content.js",
  "injected.js",
  "background.js",
  "overlay.css",
  "rules.json",
  "src/lib/idb-umd.js",
  "src/lib/parser-youtube-runtime.js",
  "src/lib/scope-youtube-runtime.js",
  "src/lib/yt-transcript-runtime.js",
  "src/lib/platform-runtime.js",
  "src/store.js",
  "src/sinks/index.js",
  "src/sinks/sheets.js",
  "src/sinks/airtable.js",
  "src/sinks/notion.js",
];

/**
 * Build a temp extension dir whose manifest matches a localhost origin.
 * Returns the path to the dir.
 */
export const buildTempExtension = ({ stubOrigin, extraHostPermissions = [] }) => {
  const dir = mkdtempSync(join(tmpdir(), "fs-ext-"));

  for (const f of EXTENSION_FILES) {
    const src = join(REPO_ROOT, f);
    const dest = join(dir, f);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(src)) copyFileSync(src, dest);
  }

  // Build a manifest pointed at the stub origin.
  // Note: chrome host_permissions don't allow ports in match patterns
  // unless explicitly written — we use http://127.0.0.1/* and rely on
  // the test driver navigating with the explicit port.
  const url = new URL(stubOrigin);
  const matchPattern = `http://${url.hostname}/*`;

  const manifest = {
    manifest_version: 3,
    name: "Feed Sorter (Test)",
    version: "0.0.0",
    permissions: ["storage", "declarativeNetRequest", "activeTab", "alarms", "tabs", "notifications"],
    host_permissions: [matchPattern, ...extraHostPermissions],
    background: { service_worker: "background.js" },
    content_scripts: [
      {
        matches: [matchPattern],
        js: [
          "src/lib/idb-umd.js",
          "src/lib/parser-youtube-runtime.js",
          "src/lib/scope-youtube-runtime.js",
          "src/lib/yt-transcript-runtime.js",
          "src/lib/platform-runtime.js",
          "src/store.js",
          "src/sinks/index.js",
          "src/sinks/sheets.js",
          "src/sinks/airtable.js",
          "src/sinks/notion.js",
          "content.js",
        ],
        css: ["overlay.css"],
        run_at: "document_start",
      },
    ],
    web_accessible_resources: [
      { resources: ["injected.js"], matches: [matchPattern] },
    ],
    declarative_net_request: {
      rule_resources: [{ id: "tag", enabled: true, path: "rules.json" }],
    },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
};

/**
 * Launch a Chromium persistent context with the extension loaded.
 * Returns { context, extensionId, close }.
 */
export const launchWithExtension = async ({ stubOrigin, host, headless = !!process.env.CI, extraHostPermissions = [] } = {}) => {
  // Accept `host` as an alias for `stubOrigin` to match the documented API.
  const origin = stubOrigin || host;
  if (!origin) throw new Error("launchWithExtension: stubOrigin/host required");
  const extDir = buildTempExtension({ stubOrigin: origin, extraHostPermissions });
  const userDataDir = mkdtempSync(join(tmpdir(), "fs-user-"));

  // Extensions in headless require Chrome's `--headless=new` arg passed
  // explicitly. Playwright's own `headless` option only accepts a bool.
  const args = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) args.unshift("--headless=new");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // never use Playwright's old headless; extensions need head-ful or --headless=new
    args,
  });

  return {
    context,
    extDir,
    userDataDir,
    close: () => context.close(),
  };
};
