// Runs in the page (MAIN world) at document_start. Watches the player's own network traffic for subtitle
// data and forwards the text to the isolated content script. Site-specific parts:
//   Prime Video : TTML / WebVTT files, and the JSON that lists the subtitle tracks
//   Netflix     : the (decrypted) playback manifest -> pick a track -> fetch its WebVTT / TTML
//   YouTube     : the player's own /api/timedtext responses (json3 / XML), optionally switching captions on
(function () {
  if (window.__primeSubsJaHooked) return;
  window.__primeSubsJaHooked = true;

  const TAG = "primesubs-ja";
  const HOST = location.hostname;
  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(HOST);
  const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(HOST);
  const seen = new Set();
  const post = (msg) => window.postMessage({ source: TAG, ...msg }, "*");

  // settings pushed by the content script (it can read chrome.storage; this world cannot)
  const cfg = { ytAutoCaptions: true };
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === TAG + "-cfg") Object.assign(cfg, e.data.cfg || {});
  });

  const ytCaptured = [];                     // language of every YouTube caption response seen
  const stats = { site: IS_NETFLIX ? "netflix" : IS_YOUTUBE ? "youtube" : "prime", scanned: 0, found: 0, recent: [] };
  let lastStat = 0;
  const pathOnly = (u) => { try { const x = new URL(u, location.href); return x.host + x.pathname.replace(/[A-Za-z0-9_-]{24,}/g, "…"); } catch { return String(u).slice(0, 60); } };
  function postStats(force) {
    const now = Date.now();
    if (!force && now - lastStat < 1000) return;
    lastStat = now;
    post({ type: "stat", stats });
  }
  const origFetch = window.fetch.bind(window);

  // ---------- Prime Video: a JSON list of tracks [{url, languageCode}] ----------
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
    for (const { url, lang } of pick) {
      if (seen.has(url)) continue;
      seen.add(url);
      origFetch(url).then((r) => r.text()).then((t) => inspect(url, "", t, { lang })).catch(() => {});
    }
    return true;
  }

  // ---------- generic response inspection ----------
  function inspect(url, ctype, text, hint) {
    stats.scanned++;
    let kind = "other";
    const lang = (hint && hint.lang) || "";
    if (typeof text === "string" && text.length > 20) {
      if (IS_YOUTUBE && /\/api\/timedtext/.test(url)) {
        const q = (() => { try { return new URL(url, location.href).searchParams; } catch { return new URLSearchParams(); } })();
        kind = "youtube";
        const ylang = q.get("tlang") || q.get("lang") || "";
        ytCaptured.push(ylang);
        post({ type: "yt", url, text, lang: ylang, asr: q.get("kind") === "asr" });
      } else if (/^\s*WEBVTT/.test(text)) { kind = "vtt"; post({ type: "vtt", url, text, lang }); }
      else if (/<tt[\s>]/.test(text.slice(0, 2000)) && /<p[\s>]/.test(text)) { kind = "ttml"; post({ type: "ttml", url, text, lang }); }
      else if (!IS_NETFLIX && !IS_YOUTUBE && (/json/i.test(ctype || "") || /^\s*[{\[]/.test(text.slice(0, 5)))) { if (scanJSON(text)) kind = "subtitle-list"; }
    }
    if (kind !== "other") {
      stats.found++;
      stats.recent.push({ kind, where: pathOnly(url), bytes: (text || "").length });
      if (stats.recent.length > 12) stats.recent.shift();
    }
    postStats(kind !== "other");
  }

  // ---------- Netflix ----------
  // The player decrypts its manifest in JS and parses it with JSON.parse; the subtitle tracks are in
  // result.timedtexttracks[]. Ask for WebVTT (and all tracks) when the manifest is requested.
  if (IS_NETFLIX) {
    const VTT = "webvtt-lssdh-ios8";
    const origParse = JSON.parse;
    JSON.parse = function () {
      const r = origParse.apply(this, arguments);
      try { nfManifest(r); } catch {}
      return r;
    };
    const origStringify = JSON.stringify;
    JSON.stringify = function (value) {
      try {
        if (value && value.params && Array.isArray(value.params.profiles)) {
          if (!value.params.profiles.includes(VTT)) value.params.profiles.push(VTT);
          value.params.showAllSubDubTracks = true;
        }
      } catch {}
      return origStringify.apply(this, arguments);
    };
    const nfUrls = (dl) => {
      if (!dl) return [];
      if (dl.downloadUrls && typeof dl.downloadUrls === "object") return Object.values(dl.downloadUrls);
      return (dl.urls || []).map((u) => u && u.url).filter(Boolean);
    };
    function nfManifest(r) {
      const res = r && (r.result || r);
      const tracks = res && res.timedtexttracks;
      if (!Array.isArray(tracks) || !tracks.length) return;
      const usable = tracks.filter((t) => t && !t.isNoneTrack && !t.isForcedNarrative && t.ttDownloadables);
      const rank = (t) => (t.trackType === "SUBTITLES" ? 0 : 1);
      const byLang = (re) => usable.filter((t) => re.test(t.language || "")).sort((a, b) => rank(a) - rank(b));
      const track = byLang(/^en/i)[0] || byLang(/^ja/i)[0];
      if (!track) return;
      for (const fmt of [VTT, "dfxp-ls-sdh", "simplesdh"]) {
        const url = nfUrls(track.ttDownloadables[fmt])[0];
        if (!url || seen.has(url)) continue;
        seen.add(url);
        origFetch(url).then((resp) => resp.text()).then((t) => inspect(url, "", t, { lang: track.language })).catch(() => {});
        break;
      }
    }
  }

  // ---------- YouTube ----------
  // Captions are only requested while they are on. Switch them on (English first, then Japanese) so the
  // translation does not depend on the viewer having pressed CC.
  if (IS_YOUTUBE) {
    let tries = 0, timer = 0, wantLang = "";
    const player = () => document.getElementById("movie_player");
    function ytEnsure() {
      if (!cfg.ytAutoCaptions) return;
      const pl = player();
      if (!pl || typeof pl.getOption !== "function") return;
      let list;
      try { list = pl.getOption("captions", "tracklist"); } catch { return; }
      if (!Array.isArray(list) || !list.length) return;
      const lang = (t) => String(t.languageCode || "");
      const asr = (t) => t.kind === "asr" || /^a\./.test(t.vss_id || "");
      const choose = (re) => list.find((t) => re.test(lang(t)) && !asr(t)) || list.find((t) => re.test(lang(t)));
      const t = choose(/^en/i) || choose(/^ja/i);
      if (!t) return;
      wantLang = lang(t);
      try { pl.setOption("captions", "track", t); } catch {}
      try { if (typeof pl.toggleSubtitlesOn === "function") pl.toggleSubtitlesOn(); } catch {}
    }
    function ytKick() {
      clearInterval(timer); tries = 0; wantLang = "";
      const base = ytCaptured.length;
      // YouTube first fetches its own default-language track; keep going until the one we asked for has arrived
      timer = setInterval(() => {
        const got = wantLang && ytCaptured.slice(base).some((l) => l.slice(0, 2) === wantLang.slice(0, 2));
        if (++tries > 14 || got) { clearInterval(timer); return; }
        ytEnsure();
      }, 1500);
    }
    window.addEventListener("yt-navigate-finish", ytKick);
    document.addEventListener("DOMContentLoaded", ytKick);
    window.addEventListener("message", (e) => { if (e.source === window && e.data && e.data.source === TAG + "-cfg") ytKick(); });
  }

  // ---------- network hooks ----------
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
