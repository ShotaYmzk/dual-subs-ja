// Runs in the page (MAIN world) at document_start. Watches the player's own
// network traffic for subtitle files (TTML/DFXP) and for playback metadata that
// lists subtitle URLs, then forwards the text to the isolated content script.
(function () {
  if (window.__primeSubsJaHooked) return;
  window.__primeSubsJaHooked = true;

  const TAG = "primesubs-ja";
  const seen = new Set();
  const post = (msg) => window.postMessage({ source: TAG, ...msg }, "*");

  const stats = { scanned: 0, found: 0, recent: [] };
  let lastStat = 0;
  const pathOnly = (u) => { try { const x = new URL(u, location.href); return x.host + x.pathname.replace(/[A-Za-z0-9_-]{24,}/g, "…"); } catch { return String(u).slice(0, 60); } };
  function postStats(force) {
    const now = Date.now();
    if (!force && now - lastStat < 1000) return;
    lastStat = now;
    post({ type: "stat", stats });
  }

  // Playback metadata (JSON) carries the subtitle tracks: [{url, languageCode, ...}].
  // Fetch the English track(s); if the title has none, fetch the Japanese one so it can be translated.
  function scanJSON(text) {
    if (typeof text !== "string" || text.indexOf("ubtitle") < 0) return false;
    let data;
    try { data = JSON.parse(text); } catch { return false; }
    const all = [];
    (function walk(o, depth) {
      if (!o || typeof o !== "object" || depth > 8) return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof o.url === "string" && /^https?:/.test(o.url) && typeof o.languageCode === "string") {
        all.push({ url: o.url, lang: o.languageCode });
      }
      for (const k in o) walk(o[k], depth + 1);
    })(data, 0);
    if (!all.length) return false;
    let pick = all.filter((x) => /^en/i.test(x.lang)).slice(0, 2);
    if (!pick.length) pick = all.filter((x) => /^ja/i.test(x.lang)).slice(0, 1);
    for (const { url } of pick) {
      if (seen.has(url)) continue;
      seen.add(url);
      origFetch(url).then((r) => r.text()).then((t) => inspect(url, "", t)).catch(() => {});
    }
    return true;
  }

  function inspect(url, ctype, text) {
    stats.scanned++;
    let kind = "other";
    if (typeof text === "string" && text.length > 50) {
      if (/^\s*WEBVTT/.test(text)) { kind = "vtt"; post({ type: "vtt", url, text }); }
      else if (/<tt[\s>]/.test(text.slice(0, 2000)) && /<p[\s>]/.test(text)) { kind = "ttml"; post({ type: "ttml", url, text }); }
      else if (/json/i.test(ctype || "") || /^\s*[{\[]/.test(text.slice(0, 5))) { if (scanJSON(text)) kind = "subtitle-list"; }
    }
    if (kind !== "other") {
      stats.found++;
      stats.recent.push({ kind, where: pathOnly(url), bytes: (text || "").length });
      if (stats.recent.length > 12) stats.recent.shift();
    }
    postStats(kind !== "other");
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    const p = origFetch(...args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      p.then((res) => {
        try {
          const ct = res.headers.get("content-type") || "";
          if (/video|audio|octet-stream|image|font/i.test(ct)) return;
          res.clone().text().then((t) => inspect(res.url || url, ct, t)).catch(() => {});
        } catch {}
      }).catch(() => {});
    } catch {}
    return p;
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__psUrl = url;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        const rt = this.responseType;
        if (rt && rt !== "text") return;
        const ct = this.getResponseHeader("content-type") || "";
        if (/video|audio|octet-stream|image|font/i.test(ct)) return;
        inspect(this.responseURL || this.__psUrl, ct, this.responseText);
      } catch {}
    });
    return XS.apply(this, arguments);
  };
})();
