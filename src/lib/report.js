// One-click PDF audit report for a creator.
// Pulls posts from __fsStore (IDB), runs the same aggregation helpers used
// by the stats sidebar, and emits a vector PDF via jsPDF (window.jspdf).
//
// Public API: window.__fsReport.generate(username) -> Promise<{ ok, bytes, filename }>

(() => {
  if (window.__fsReport) return;

  // ---------- math helpers (mirror content.js so this lib stays standalone) ----------
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const quantile = (xs, q) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return s[lo];
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  const fmt = (n) => {
    if (!n && n !== 0) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };
  const fmtScore = (s) => (s ? s.toFixed(2) + "x" : "—");
  const fmtDateISO = (t) => {
    if (!t) return "—";
    const d = new Date(t * 1000);
    return d.toISOString().slice(0, 10);
  };
  const todayISO = () => new Date().toISOString().slice(0, 10);

  const formatOf = (p) => {
    if (p.isReel || p.mediaType === 2) return "reel";
    if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
    return "single";
  };

  const HASHTAG_RE = /#([\w_]+)/g;

  // Per-author median baseline; falls back to global median.
  const enrichScores = (list, metric = "likes") => {
    const byAuthor = new Map();
    const globalVals = [];
    for (const p of list) {
      const v = p[metric] || 0;
      if (v > 0) globalVals.push(v);
      const k = p.author || "_unknown";
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(v);
    }
    const globalMed = median(globalVals);
    const meds = new Map();
    for (const [a, vals] of byAuthor) {
      const positive = vals.filter((x) => x > 0);
      meds.set(a, positive.length >= 2 ? median(positive) : 0);
    }
    return list.map((p) => {
      const authorMed = meds.get(p.author || "_unknown") || 0;
      const baseline = authorMed || globalMed;
      const score = baseline > 0 ? (p[metric] || 0) / baseline : 0;
      return { ...p, _score: score };
    });
  };

  const extractHook = (desc) => {
    const first = String(desc || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
    return first.slice(0, 140);
  };
  const hookTypeOf = (p) => {
    const h = (p.hook || extractHook(p.desc || "")).trim();
    if (!h) return "none";
    const raw = (p.desc || "").split("\n")[0].trim();
    if (/\?\s*$/.test(raw)) return "question";
    if (/^(how |why |what |when |where |who )/i.test(h)) return "how-to";
    if (/^\d+\b/.test(h)) return "list";
    if (/!\s*$/.test(raw)) return "exclamation";
    if (/^(stop |don.?t |never |avoid )/i.test(h)) return "warning";
    if (/^(i |my )/i.test(h)) return "personal";
    return "statement";
  };

  // ---------- aggregations ----------
  const computeReport = (rawPosts, username) => {
    const posts = enrichScores(rawPosts, "likes");
    const total = posts.length;

    const likes = posts.map((p) => p.likes || 0).filter((v) => v > 0);
    const views = posts.map((p) => p.views || 0).filter((v) => v > 0);
    const comments = posts.map((p) => p.comments || 0).filter((v) => v > 0);

    const headline = {
      medianLikes: median(likes),
      p90Likes: quantile(likes, 0.9),
      medianViews: median(views),
      p90Views: quantile(views, 0.9),
      medianComments: median(comments),
      p90Comments: quantile(comments, 0.9),
    };

    const formats = { reel: 0, carousel: 0, single: 0 };
    const surfaces = {};
    for (const p of posts) {
      formats[formatOf(p)]++;
      const s = p.surface || "unknown";
      surfaces[s] = (surfaces[s] || 0) + 1;
    }

    const top10 = [...posts]
      .filter((p) => p.cover || p.url)
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, 10);

    // Monthly median (likes) trend, limited to last 18 buckets.
    const buckets = new Map(); // "YYYY-MM" -> []
    for (const p of posts) {
      if (!p.createTime || !p.likes) continue;
      const d = new Date(p.createTime * 1000);
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p.likes);
    }
    const trend = [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-18)
      .map(([k, vs]) => ({ bucket: k, median: median(vs), n: vs.length }));

    // 7x24 cadence, mean score per cell.
    const cadence = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ n: 0, sum: 0 }))
    );
    for (const p of posts) {
      if (!p.createTime) continue;
      const d = new Date(p.createTime * 1000);
      cadence[d.getDay()][d.getHours()].n++;
      cadence[d.getDay()][d.getHours()].sum += p._score || 0;
    }

    // Hashtag lift (top 10).
    const counts = new Map();
    const sums = new Map();
    let allSum = 0;
    let allN = 0;
    for (const p of posts) {
      const s = p._score || 0;
      allSum += s;
      allN++;
      const seen = new Set();
      HASHTAG_RE.lastIndex = 0;
      let m;
      const desc = p.desc || "";
      while ((m = HASHTAG_RE.exec(desc)) !== null) {
        const t = m[1].toLowerCase();
        if (seen.has(t)) continue;
        seen.add(t);
        counts.set(t, (counts.get(t) || 0) + 1);
        sums.set(t, (sums.get(t) || 0) + s);
      }
    }
    const hashtagRows = [];
    for (const [t, n] of counts) {
      if (n < 3) continue;
      const meanWith = sums.get(t) / n;
      const remN = allN - n;
      const meanWithout = remN > 0 ? (allSum - sums.get(t)) / remN : 0;
      const lift = meanWithout > 0 ? meanWith / meanWithout : (meanWith > 0 ? Infinity : 0);
      hashtagRows.push({ tag: t, n, lift, meanWith });
    }
    hashtagRows.sort((a, b) => b.lift - a.lift);
    const hashtags = hashtagRows.slice(0, 10);

    // Caption length histogram (log-scale buckets, like content.js).
    const lens = posts.map((p) => (p.desc || "").length);
    const positive = lens.filter((x) => x > 0);
    const maxLen = positive.length ? Math.max(...positive) : 1;
    const nb = 16;
    const maxExp = Math.max(1, Math.log10(maxLen + 1));
    const histAll = new Array(nb).fill(0);
    const histOut = new Array(nb).fill(0);
    for (const p of posts) {
      const len = (p.desc || "").length;
      if (len <= 0) continue;
      const exp = Math.log10(len);
      let b = Math.floor((exp / maxExp) * nb);
      if (b < 0) b = 0;
      if (b >= nb) b = nb - 1;
      histAll[b]++;
      if ((p._score || 0) >= 2) histOut[b]++;
    }
    const captionHist = { all: histAll, outlier: histOut, nb, maxLen };

    // Hook patterns: count + median outlier score per hookType.
    const hookGroups = new Map();
    for (const p of posts) {
      const ht = hookTypeOf(p);
      if (!hookGroups.has(ht)) hookGroups.set(ht, []);
      hookGroups.get(ht).push(p._score || 0);
    }
    const hooks = [...hookGroups.entries()]
      .map(([type, scores]) => ({ type, n: scores.length, medianScore: median(scores) }))
      .sort((a, b) => b.n - a.n);

    // Date range.
    const times = posts.map((p) => p.createTime).filter((t) => t > 0);
    const minT = times.length ? Math.min(...times) : 0;
    const maxT = times.length ? Math.max(...times) : 0;

    return {
      username,
      total,
      dateRange: { from: minT, to: maxT },
      headline,
      formats,
      surfaces,
      top10,
      trend,
      cadence,
      hashtags,
      captionHist,
      hooks,
    };
  };

  // ---------- thumbnail loading (best-effort; CORS may block) ----------
  const loadImageDataURL = (url, maxW = 200, maxH = 280, timeoutMs = 4000) =>
    new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
          const w = Math.max(1, Math.round(img.width * ratio));
          const h = Math.max(1, Math.round(img.height * ratio));
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          finish({ data: c.toDataURL("image/jpeg", 0.78), w, h });
        } catch {
          finish(null); // tainted canvas
        }
      };
      img.onerror = () => { clearTimeout(timer); finish(null); };
      img.src = url;
    });

  // ---------- PDF rendering ----------
  const COLORS = {
    text: [24, 24, 27],
    sub: [113, 113, 122],
    accent: [16, 100, 250],
    warm: [218, 78, 24],
    grid: [220, 220, 226],
    bar: [16, 100, 250],
    barAlt: [180, 200, 245],
    heat: [16, 100, 250],
  };

  const PAGE_W = 595.28; // A4 portrait pt
  const PAGE_H = 841.89;
  const M = 40; // margin

  class Cursor {
    constructor(doc) {
      this.doc = doc;
      this.y = M;
    }
    space(n) { this.y += n; }
    needRoom(h) {
      if (this.y + h > PAGE_H - M) {
        this.doc.addPage();
        this.y = M;
        this.drawFooter();
      }
    }
    drawFooter() {
      const { doc } = this;
      const n = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(...COLORS.sub);
      doc.text(`page ${n}`, PAGE_W - M, PAGE_H - 16, { align: "right" });
    }
  }

  const setText = (doc, size, color = COLORS.text, style = "normal") => {
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.setFont("helvetica", style);
  };

  const sectionHeader = (doc, cur, label) => {
    cur.needRoom(36);
    setText(doc, 13, COLORS.text, "bold");
    doc.text(label, M, cur.y);
    doc.setDrawColor(...COLORS.grid);
    doc.setLineWidth(0.5);
    doc.line(M, cur.y + 4, PAGE_W - M, cur.y + 4);
    cur.y += 18;
  };

  const drawCover = (doc, cur, r) => {
    setText(doc, 10, COLORS.sub);
    doc.text("FEED SORTER · CREATOR AUDIT", M, cur.y);
    cur.y += 22;
    setText(doc, 28, COLORS.text, "bold");
    doc.text(`@${r.username}`, M, cur.y);
    cur.y += 30;
    setText(doc, 11, COLORS.sub);
    const fromS = fmtDateISO(r.dateRange.from);
    const toS = fmtDateISO(r.dateRange.to);
    doc.text(`Posts captured: ${r.total}`, M, cur.y);
    cur.y += 14;
    doc.text(`Date range: ${fromS} → ${toS}`, M, cur.y);
    cur.y += 14;
    doc.text(`Generated: ${new Date().toLocaleString()}`, M, cur.y);
    cur.y += 24;
  };

  const drawHeadlineStats = (doc, cur, r) => {
    sectionHeader(doc, cur, "Headline stats");
    const h = r.headline;
    const rows = [
      ["likes",    fmt(h.medianLikes),    fmt(h.p90Likes)],
      ["views",    fmt(h.medianViews),    fmt(h.p90Views)],
      ["comments", fmt(h.medianComments), fmt(h.p90Comments)],
    ];
    const colW = [110, 90, 90];
    const x0 = M;
    const rowH = 18;
    setText(doc, 9, COLORS.sub, "bold");
    doc.text("metric", x0, cur.y);
    doc.text("median", x0 + colW[0], cur.y, { align: "right" });
    doc.text("p90",    x0 + colW[0] + colW[1], cur.y, { align: "right" });
    cur.y += 6;
    doc.setDrawColor(...COLORS.grid);
    doc.line(x0, cur.y, x0 + colW[0] + colW[1] + colW[2], cur.y);
    cur.y += 12;
    setText(doc, 10, COLORS.text);
    for (const row of rows) {
      doc.text(row[0], x0, cur.y);
      doc.text(row[1], x0 + colW[0], cur.y, { align: "right" });
      doc.text(row[2], x0 + colW[0] + colW[1], cur.y, { align: "right" });
      cur.y += rowH;
    }
    cur.space(8);

    // Format + surface mini-tables side by side.
    cur.needRoom(110);
    const yStart = cur.y;
    setText(doc, 10, COLORS.text, "bold");
    doc.text("Posts by format", M, yStart);
    doc.text("Posts by surface", M + 270, yStart);
    setText(doc, 9, COLORS.text);
    const fmtRows = Object.entries(r.formats).filter(([, n]) => n > 0);
    const surfRows = Object.entries(r.surfaces).sort((a, b) => b[1] - a[1]);
    let y1 = yStart + 14;
    for (const [k, v] of fmtRows) {
      doc.text(`${k}`, M, y1);
      doc.text(String(v), M + 130, y1, { align: "right" });
      y1 += 12;
    }
    let y2 = yStart + 14;
    for (const [k, v] of surfRows) {
      doc.text(`${k}`, M + 270, y2);
      doc.text(String(v), M + 400, y2, { align: "right" });
      y2 += 12;
    }
    cur.y = Math.max(y1, y2) + 6;
  };

  const drawTopOutliers = async (doc, cur, r) => {
    sectionHeader(doc, cur, "Top 10 outliers");
    if (!r.top10.length) {
      setText(doc, 10, COLORS.sub);
      doc.text("No posts to rank.", M, cur.y);
      cur.y += 16;
      return;
    }
    setText(doc, 9, COLORS.sub, "bold");
    doc.text("#",       M,         cur.y);
    doc.text("score",   M + 26,    cur.y);
    doc.text("likes",   M + 70,    cur.y);
    doc.text("views",   M + 110,   cur.y);
    doc.text("caption", M + 165,   cur.y);
    cur.y += 8;
    doc.setDrawColor(...COLORS.grid);
    doc.line(M, cur.y, PAGE_W - M, cur.y);
    cur.y += 8;

    // Best-effort thumbnail load (parallel).
    const thumbs = await Promise.all(
      r.top10.map((p) => loadImageDataURL(p.cover, 80, 100))
    );

    setText(doc, 9, COLORS.text);
    for (let i = 0; i < r.top10.length; i++) {
      const p = r.top10[i];
      const rowH = 56;
      cur.needRoom(rowH + 4);
      const y = cur.y;
      setText(doc, 9, COLORS.sub);
      doc.text(String(i + 1), M, y + 10);
      const t = thumbs[i];
      if (t) {
        try {
          const tw = 36;
          const th = (t.h / t.w) * tw;
          doc.addImage(t.data, "JPEG", M + 14, y, tw, Math.min(th, 50));
        } catch { /* ignore */ }
      }
      setText(doc, 11, COLORS.warm, "bold");
      doc.text(fmtScore(p._score), M + 56, y + 10);
      setText(doc, 9, COLORS.text);
      doc.text(fmt(p.likes), M + 56, y + 24);
      doc.text(fmt(p.views), M + 96, y + 24);
      const cap = (p.desc || "").replace(/\s+/g, " ").trim().slice(0, 220);
      const lines = doc.splitTextToSize(cap || "(no caption)", PAGE_W - M - (M + 145));
      doc.text(lines.slice(0, 3), M + 145, y + 10);
      if (p.url) {
        setText(doc, 8, COLORS.accent);
        doc.textWithLink(p.url.length > 60 ? p.url.slice(0, 57) + "…" : p.url, M + 145, y + 46, { url: p.url });
      }
      cur.y += rowH;
      doc.setDrawColor(...COLORS.grid);
      doc.line(M, cur.y - 2, PAGE_W - M, cur.y - 2);
    }
    cur.space(6);
  };

  const drawTrendSparkline = (doc, cur, r) => {
    sectionHeader(doc, cur, "Monthly median likes (trend)");
    if (!r.trend.length) {
      setText(doc, 10, COLORS.sub);
      doc.text("Not enough dated posts to plot a trend.", M, cur.y);
      cur.y += 16;
      return;
    }
    const w = PAGE_W - 2 * M;
    const h = 110;
    cur.needRoom(h + 28);
    const x0 = M;
    const y0 = cur.y;
    doc.setDrawColor(...COLORS.grid);
    doc.setLineWidth(0.5);
    doc.rect(x0, y0, w, h);
    const max = Math.max(1, ...r.trend.map((d) => d.median));
    const n = r.trend.length;
    const stepX = w / Math.max(1, n - 1);
    // Bars + line.
    const barW = Math.max(2, stepX * 0.6);
    doc.setFillColor(...COLORS.barAlt);
    for (let i = 0; i < n; i++) {
      const v = r.trend[i].median;
      const bh = (v / max) * (h - 18);
      const xC = x0 + i * stepX;
      doc.rect(xC - barW / 2, y0 + h - bh, barW, bh, "F");
    }
    doc.setDrawColor(...COLORS.accent);
    doc.setLineWidth(1.2);
    let prev = null;
    for (let i = 0; i < n; i++) {
      const v = r.trend[i].median;
      const x = x0 + i * stepX;
      const y = y0 + h - (v / max) * (h - 18);
      if (prev) doc.line(prev.x, prev.y, x, y);
      doc.setFillColor(...COLORS.accent);
      doc.circle(x, y, 1.6, "F");
      prev = { x, y };
    }
    setText(doc, 7, COLORS.sub);
    // X labels: first / mid / last.
    const labels = [0, Math.floor(n / 2), n - 1];
    for (const i of labels) {
      const x = x0 + i * stepX;
      doc.text(r.trend[i].bucket, x, y0 + h + 10, { align: i === 0 ? "left" : i === n - 1 ? "right" : "center" });
    }
    doc.text(`max ${fmt(max)}`, x0 + w, y0 - 4, { align: "right" });
    cur.y = y0 + h + 18;
  };

  const drawCadenceHeatmap = (doc, cur, r) => {
    sectionHeader(doc, cur, "Posting cadence (7×24, mean outlier score)");
    const labelsX = ["12a", "3a", "6a", "9a", "12p", "3p", "6p", "9p"];
    const labelsY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const cellW = (PAGE_W - 2 * M - 28) / 24;
    const cellH = 16;
    const xL = M + 28;
    cur.needRoom(7 * cellH + 30);
    // Compute max for normalization.
    let maxN = 0, maxScore = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const c = r.cadence[d][h];
        if (c.n > maxN) maxN = c.n;
        const s = c.n ? c.sum / c.n : 0;
        if (s > maxScore) maxScore = s;
      }
    }
    setText(doc, 7, COLORS.sub);
    for (let d = 0; d < 7; d++) doc.text(labelsY[d], M, cur.y + d * cellH + 11);
    for (let h = 0; h < 24; h++) {
      if (h % 3 === 0) doc.text(labelsX[h / 3], xL + h * cellW, cur.y - 2, { align: "left" });
    }
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const c = r.cadence[d][h];
        const meanScore = c.n ? c.sum / c.n : 0;
        // Alpha by post count, hue intensity by mean score.
        const alpha = maxN ? c.n / maxN : 0;
        const intensity = maxScore ? Math.min(1, meanScore / maxScore) : 0;
        const r0 = 245 - alpha * 100;
        const g0 = 245 - alpha * (100 - intensity * 90);
        const b0 = 245 - alpha * (40 - intensity * 200);
        doc.setFillColor(Math.round(r0), Math.round(g0), Math.round(b0));
        doc.rect(xL + h * cellW, cur.y + d * cellH, cellW - 1, cellH - 1, "F");
      }
    }
    cur.y += 7 * cellH + 14;
    setText(doc, 7, COLORS.sub);
    doc.text(`max posts/cell: ${maxN} · max mean score: ${maxScore.toFixed(2)}x`, M, cur.y);
    cur.y += 12;
  };

  const drawHashtagLift = (doc, cur, r) => {
    sectionHeader(doc, cur, "Hashtag lift (top 10, n≥3)");
    if (!r.hashtags.length) {
      setText(doc, 10, COLORS.sub);
      doc.text("Not enough hashtag samples (need ≥3 uses per tag).", M, cur.y);
      cur.y += 16;
      return;
    }
    const cols = [
      { k: "#tag",         w: 200, align: "left" },
      { k: "n",            w: 50,  align: "right" },
      { k: "mean score",   w: 100, align: "right" },
      { k: "lift vs rest", w: 100, align: "right" },
    ];
    let x = M;
    setText(doc, 9, COLORS.sub, "bold");
    for (const c of cols) {
      doc.text(c.k, x + (c.align === "right" ? c.w : 0), cur.y, { align: c.align });
      x += c.w;
    }
    cur.y += 6;
    doc.setDrawColor(...COLORS.grid);
    doc.line(M, cur.y, M + cols.reduce((a, c) => a + c.w, 0), cur.y);
    cur.y += 10;
    setText(doc, 9, COLORS.text);
    for (const row of r.hashtags) {
      cur.needRoom(14);
      let cx = M;
      doc.text(`#${row.tag}`, cx, cur.y); cx += cols[0].w;
      doc.text(String(row.n), cx + cols[1].w, cur.y, { align: "right" }); cx += cols[1].w;
      doc.text(row.meanWith.toFixed(2) + "x", cx + cols[2].w, cur.y, { align: "right" }); cx += cols[2].w;
      const lift = isFinite(row.lift) ? row.lift.toFixed(2) + "x" : "∞";
      doc.text(lift, cx + cols[3].w, cur.y, { align: "right" });
      cur.y += 13;
    }
    cur.space(6);
  };

  const drawCaptionHist = (doc, cur, r) => {
    sectionHeader(doc, cur, "Caption length distribution (log-scale buckets)");
    const { all, outlier, nb, maxLen } = r.captionHist;
    const total = all.reduce((a, b) => a + b, 0);
    if (!total) {
      setText(doc, 10, COLORS.sub);
      doc.text("No captions to plot.", M, cur.y);
      cur.y += 16;
      return;
    }
    const w = PAGE_W - 2 * M;
    const h = 100;
    cur.needRoom(h + 28);
    const x0 = M;
    const y0 = cur.y;
    doc.setDrawColor(...COLORS.grid);
    doc.rect(x0, y0, w, h);
    const max = Math.max(...all);
    const bw = w / nb;
    for (let i = 0; i < nb; i++) {
      const a = all[i];
      const o = outlier[i];
      const ah = (a / max) * (h - 12);
      const oh = (o / max) * (h - 12);
      doc.setFillColor(...COLORS.barAlt);
      doc.rect(x0 + i * bw + 1, y0 + h - ah, bw - 2, ah, "F");
      doc.setFillColor(...COLORS.warm);
      doc.rect(x0 + i * bw + 1, y0 + h - oh, bw - 2, oh, "F");
    }
    setText(doc, 7, COLORS.sub);
    doc.text("0 chars", x0, y0 + h + 10);
    doc.text(`${maxLen} chars`, x0 + w, y0 + h + 10, { align: "right" });
    doc.text("blue: all posts · orange: outliers (≥2x)", x0 + w / 2, y0 + h + 10, { align: "center" });
    cur.y = y0 + h + 16;
  };

  const drawHooks = (doc, cur, r) => {
    sectionHeader(doc, cur, "Hook patterns");
    if (!r.hooks.length) {
      setText(doc, 10, COLORS.sub);
      doc.text("No hooks detected.", M, cur.y);
      cur.y += 16;
      return;
    }
    setText(doc, 9, COLORS.sub, "bold");
    doc.text("hook type", M, cur.y);
    doc.text("count",    M + 200, cur.y, { align: "right" });
    doc.text("median outlier", M + 320, cur.y, { align: "right" });
    cur.y += 6;
    doc.setDrawColor(...COLORS.grid);
    doc.line(M, cur.y, M + 320, cur.y);
    cur.y += 10;
    setText(doc, 9, COLORS.text);
    for (const h of r.hooks) {
      cur.needRoom(14);
      doc.text(h.type, M, cur.y);
      doc.text(String(h.n), M + 200, cur.y, { align: "right" });
      doc.text(fmtScore(h.medianScore), M + 320, cur.y, { align: "right" });
      cur.y += 13;
    }
  };

  // ---------- entry point ----------
  const generate = async (username) => {
    const u = String(username || "").trim().toLowerCase().replace(/^@/, "");
    if (!u) return { ok: false, error: "no username" };
    if (!window.__fsStore) return { ok: false, error: "store unavailable" };
    if (!window.jspdf || !window.jspdf.jsPDF) return { ok: false, error: "jspdf unavailable" };

    const raw = await window.__fsStore.getByAuthor(u);
    if (!raw || !raw.length) return { ok: false, error: "no posts in IDB for this creator" };

    const r = computeReport(raw, u);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const cur = new Cursor(doc);
    cur.drawFooter();

    drawCover(doc, cur, r);
    drawHeadlineStats(doc, cur, r);
    await drawTopOutliers(doc, cur, r);
    drawTrendSparkline(doc, cur, r);
    drawCadenceHeatmap(doc, cur, r);
    drawHashtagLift(doc, cur, r);
    drawCaptionHist(doc, cur, r);
    drawHooks(doc, cur, r);

    const filename = `audit_${u}_${todayISO()}.pdf`;
    doc.save(filename);

    const blob = doc.output("blob");
    return { ok: true, filename, bytes: blob.size, posts: r.total };
  };

  window.__fsReport = { generate, _computeReport: computeReport };
})();
