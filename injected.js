// Page-world hook: wraps fetch + XHR so the content script can see
// Instagram's own feed/explore/graphql responses.
(() => {
  const SOURCE = "feed-sorter";
  const TAG_HEADER = "x-feed-sorter-tag";

  // ----- page-world API: window.fs -----
  // Lets you inspect logs/posts and trigger collection from the DevTools
  // console without poking into extension internals.
  const LOG_BUF = [];
  const LOG_MAX = 1000;

  const send = (cmd, payload = {}) =>
    window.postMessage({ source: SOURCE, kind: "cmd", cmd, ...payload }, "*");

  const api = {
    /** Last `n` log entries (default all). */
    logs(n) { return n ? LOG_BUF.slice(-n) : LOG_BUF.slice(); },
    /** Filter logs by event name substring. */
    logsWhere(match) {
      const re = match instanceof RegExp ? match : new RegExp(String(match));
      return LOG_BUF.filter((e) => re.test(e.event));
    },
    /** Pretty-print recent logs as a table. */
    tail(n = 30) {
      const rows = LOG_BUF.slice(-n).map((e) => ({
        time: new Date(e.t).toLocaleTimeString(),
        event: e.event,
        ...Object.fromEntries(
          Object.entries(e).filter(([k]) => k !== "t" && k !== "event")
        ),
      }));
      console.table(rows);
      return rows.length;
    },
    /** Clear in-memory log buffer (page-world only). */
    clearLogs() { LOG_BUF.length = 0; },
    /** Snapshot of currently captured posts. Resolves async. */
    posts() {
      return new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const onMsg = (ev) => {
          if (ev.source !== window) return;
          const d = ev.data;
          if (!d || d.source !== SOURCE || d.kind !== "reply" || d.id !== id) return;
          window.removeEventListener("message", onMsg);
          resolve(d.posts || []);
        };
        window.addEventListener("message", onMsg);
        send("get-posts", { id });
        setTimeout(() => { window.removeEventListener("message", onMsg); resolve([]); }, 2000);
      });
    },
    collect() { send("start-collect"); return "started"; },
    stop()    { send("stop-collect");  return "stopping"; },
    setFilter(key, value) { send("set-filter", { key, value }); },
    // Explicit profile-info fetch — IG embeds the user blob in the initial
    // HTML so the XHR interceptor never fires for plain profile loads. The
    // content script triggers this via window.postMessage on boot/scope
    // change when scope.kind === "profile". We use page-world fetch so
    // (a) the wrapped origFetch below still posts the response back through
    //     the same `feed-response` channel the rest of the parsers use,
    // (b) credentials + ALL of IG's page-defined fetch defaults flow through.
    fetchProfile(platform, username) {
      if (!username) return Promise.resolve(false);
      const p = String(platform || "").toLowerCase();
      if (p === "instagram") {
        const url = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
        return window.fetch(url, {
          credentials: "include",
          headers: { "X-IG-App-ID": "936619743392459" },
        }).then(() => true).catch(() => false);
      }
      // TikTok signature/bio is embedded in the page's __UNIVERSAL_DATA_FOR_REHYDRATION__
      // script tag rather than fetched as XHR — handled separately by the
      // content script's DOM scrape (not implemented here yet).
      return Promise.resolve(false);
    },
  };
  Object.defineProperty(window, "fs", { value: api, configurable: true });
  console.log("%c[FS] page-world API ready: window.fs.tail(), fs.logs(), fs.posts(), fs.collect()", "color:#e1306c");

  // Listen for log entries + command messages posted by the content script.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SOURCE) return;
    if (d.kind === "log" && d.entry) {
      LOG_BUF.push(d.entry);
      if (LOG_BUF.length > LOG_MAX) LOG_BUF.shift();
      return;
    }
    if (d.kind === "fetch-profile" && d.username) {
      // Fire-and-forget. The wrapped window.fetch below will post the
      // response back through the existing `feed-response` channel; the
      // content script's profile branch (src/lib/profile-parser-runtime.js)
      // parses + persists onto the creators row.
      api.fetchProfile(d.platform, d.username);
    }
  });

  // We try to ID feed-bearing responses by URL too, in case the DNR rule
  // didn't fire (cross-subdomain etc.).
  // YouTube innertube interception: pattern from
  // `zerodytrash/Simple-YouTube-Age-Restriction-Bypass` `main.js` — wrap
  // fetch + XHR, match /youtubei/v1/(player|next|browse) plus Shorts reel
  // endpoints, surface the payload to the content script via window.postMessage.
  //
  // Profile-info endpoints were added later (bio-first niche cascade,
  // src/lib/niche-signal.js): IG `users/web_profile_info`,
  // legacy `users/<id>/info`, and TT `api/user/detail`.
  const URL_RE = /\/(api\/v1\/(feed\/user|clips\/user|discover|users\/web_profile_info|users\/[0-9]+\/info)|graphql\/query|api\/(post|recommend|explore|related|user)\/(item_list|detail)|youtubei\/v1\/(player|next|browse|reel\/(reel_item_watch|reel_watch_sequence)))/;

  const post = (payload) => {
    try { window.postMessage({ source: SOURCE, ...payload }, "*"); } catch {}
  };

  const origFetch = window.fetch;
  if (origFetch && !window.__feedSorterFetchHooked) {
    window.__feedSorterFetchHooked = true;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = res.url || (typeof args[0] === "string" ? args[0] : args[0]?.url) || "";
        let tag = "";
        try { tag = res.headers.get(TAG_HEADER) || ""; } catch {}
        if (tag || URL_RE.test(url)) {
          res.clone().text()
            .then((body) => post({ kind: "feed-response", url, tag, body }))
            .catch(() => {});
        }
      } catch {}
      return res;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && !window.__feedSorterXHRHooked) {
    window.__feedSorterXHRHooked = true;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      this.__fs_url = url;
      return origOpen.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.send = function (...sendArgs) {
      this.addEventListener("load", () => {
        try {
          const url = this.__fs_url || "";
          let tag = "";
          try { tag = this.getResponseHeader(TAG_HEADER) || ""; } catch {}
          if (tag || URL_RE.test(url)) {
            post({ kind: "feed-response", url, tag, body: this.responseText });
          }
        } catch {}
      });
      return origSend.apply(this, sendArgs);
    };
  }
})();
