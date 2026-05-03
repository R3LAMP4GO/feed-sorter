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
  };
  Object.defineProperty(window, "fs", { value: api, configurable: true });
  console.log("%c[FS] page-world API ready: window.fs.tail(), fs.logs(), fs.posts(), fs.collect()", "color:#e1306c");

  // Listen for log entries posted by the content script.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SOURCE) return;
    if (d.kind === "log" && d.entry) {
      LOG_BUF.push(d.entry);
      if (LOG_BUF.length > LOG_MAX) LOG_BUF.shift();
    }
  });

  // We try to ID feed-bearing responses by URL too, in case the DNR rule
  // didn't fire (cross-subdomain etc.).
  const URL_RE = /\/(api\/v1\/(feed\/user|clips\/user|discover)|graphql\/query|api\/(post|recommend|explore|related)\/item_list)/;

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
        const tag = res.headers.get(TAG_HEADER);
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
          const tag = this.getResponseHeader(TAG_HEADER);
          if (tag || URL_RE.test(url)) {
            post({ kind: "feed-response", url, tag, body: this.responseText });
          }
        } catch {}
      });
      return origSend.apply(this, sendArgs);
    };
  }
})();
