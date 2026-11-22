// Runs in the page (MAIN world) at document_start. Watches the player's own network traffic for subtitle
// data and forwards the text to the isolated content script. Site-specific parts:
//   Prime Video : TTML / WebVTT files, and the JSON that lists the subtitle tracks
//   Netflix     : the (decrypted) playback manifest -> pick a track -> fetch its WebVTT / TTML
//   Disney+     : HLS master playlist -> English subtitle playlist -> WebVTT segments, joined
//   YouTube     : the player's own /api/timedtext responses (json3 / XML), optionally switching captions on
(function () {
  if (window.__primeSubsJaHooked) return;
  window.__primeSubsJaHooked = true;

  const TAG = "primesubs-ja";
  const HOST = location.hostname;
  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(HOST);
  const IS_YOUTUBE = /(^|\.)youtube\.com$/.test(HOST);
  const IS_DISNEY = /(^|\.)disneyplus\.com$/.test(HOST);
  const seen = new Set();
  const post = (msg) => window.postMessage({ source: TAG, ...msg }, "*");

  // settings pushed by the content script (it can read chrome.storage; this world cannot)
  const cfg = { ytAutoCaptions: true };
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === TAG + "-cfg") Object.assign(cfg, e.data.cfg || {});
  });

  const ytCaptured = [];                     // language of every YouTube caption response seen
  const stats = { site: IS_NETFLIX ? "netflix" : IS_YOUTUBE ? "youtube" : IS_DISNEY ? "disney" : "prime", scanned: 0, found: 0, recent: [], disney: { paths: [], errors: [] } };
  let lastStat = 0;
  const pathOnly = (u) => { try { const x = new URL(u, location.href); return x.host + x.pathname.replace(/[A-Za-z0-9_-]{24,}/g, "…"); } catch { return String(u).slice(0, 60); } };
  function noteDisney(url, ct, state) {
    if (!IS_DISNEY) return;
    const where = pathOnly(url);
    const paths = stats.disney.paths;
    const old = paths.find((x) => x.where === where);
    if (old) { old.state = state; old.contentType = ct; }
    else { paths.push({ where, contentType: ct, state }); if (paths.length > 80) paths.shift(); }
    postStats(false);
  }
  function disneyError(url, error) {
    stats.disney.errors.push({ where: pathOnly(url), error: String(error).slice(0, 160) });
    if (stats.disney.errors.length > 12) stats.disney.errors.shift();
    postStats(true);
  }
  // HLS also uses audio/mpegurl and video/* MIME types; test text formats first.
  function readable(url, ct) {
    if (/mpegurl|vtt|ttml|json|text\//i.test(ct) || /\.(m3u8|vtt|webvtt|ttml|dfxp)(?:[?#]|$)/i.test(url)) return true;
    return !/^(?:video|audio|image|font)\//i.test(ct) && !/octet-stream/i.test(ct);
  }
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
    noteDisney(url, ctype, "inspected");
    let kind = "other";
    const lang = (hint && hint.lang) || "";
    // Normalize a BOM before recognizing playlist and subtitle signatures.
    if (typeof text === "string") text = text.replace(/^\uFEFF/, "");
    if (typeof text === "string" && text.length > 20) {
      if (IS_YOUTUBE && /\/api\/timedtext/.test(url)) {
        const q = (() => { try { return new URL(url, location.href).searchParams; } catch { return new URLSearchParams(); } })();
        kind = "youtube";
        const ylang = q.get("tlang") || q.get("lang") || "";
        ytCaptured.push(ylang);
        post({ type: "yt", url, text, lang: ylang, asr: q.get("kind") === "asr" });
      } else if (/^\s*WEBVTT/.test(text)) { kind = "vtt"; post({ type: "vtt", url, text, lang }); }
      else if (/<tt[\s>]/.test(text.slice(0, 2000)) && /<p[\s>]/.test(text)) { kind = "ttml"; post({ type: "ttml", url, text, lang }); }
      else if (IS_DISNEY && /^\s*#EXTM3U/.test(text)) { if (disneyPlaylist(url, text)) kind = "hls"; }
      else if (!IS_NETFLIX && !IS_YOUTUBE && (/json/i.test(ctype || "") || /^\s*[{\[]/.test(text.slice(0, 5)))) { if (IS_DISNEY ? disneyJSON(url, text) : scanJSON(text)) kind = "subtitle-list"; }
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

  // ---------- Disney+ ----------
  // Streams over HLS. The master playlist lists subtitle renditions (#EXT-X-MEDIA TYPE=SUBTITLES); each is a
  // media playlist of WebVTT segments. Pick English (else Japanese), fetch every segment, join them into one VTT.
  // JSON manifests vary by client. Only follow text tracks or explicit HLS URLs.
  function disneyJSON(base, text) {
    let data; try { data = JSON.parse(text); } catch { return false; }
    const tracks = [];
    function walk(o, context = "", lang = "", depth = 0) {
      if (!o || typeof o !== "object" || depth > 16) return;
      const language = o.languageCode || o.language || o.lang || lang;
      const ctx = context + " " + [o.type, o.kind, o.format].filter(Boolean).join(" ");
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && /^(https?:|\.?\.?\/)/.test(v) &&
          (/\.(m3u8|vtt|ttml|dfxp)(?:[?#]|$)/i.test(v) || (/subtitle|caption|timedtext/i.test(ctx) && /url|uri|href/i.test(k)))) {
          if (!/forced/i.test(ctx) && (!language || /^(en|ja)(?:-|$)/i.test(language))) {
            try { tracks.push({ url: new URL(v, base).href, lang: typeof language === "string" ? language : "" }); } catch {}
          }
        } else if (v && typeof v === "object") walk(v, ctx + " " + k, language, depth + 1);
      }
    }
    walk(data);
    const en = tracks.filter((t) => /^en/i.test(t.lang));
    for (const t of en.length ? en : tracks) disneyLoad(t.url, t.lang);
    return tracks.length > 0;
  }
  function disneyLoad(url, lang) {
    if (seen.has(url)) return;
    seen.add(url);
    disneyFetch(url, lang).catch((e) => { seen.delete(url); disneyError(url, e); });
  }
  function disneyPlaylist(url, text) {
    if (!/#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES/.test(text)) {
      // A player may request only the subtitle media playlist, without a master.
      if (/#EXTINF:/.test(text) && /(?:\.vtt(?:[?\s]|$)|subtitle|caption|timedtext)/i.test(text + "\n" + url)) {
        disneyLoad(url, ""); return true;
      }
      return false;
    }
    const attr = (line, k) => { const m = line.match(new RegExp("(?:^|[,:])" + k + '=(?:"([^"]*)"|([^,]*))')); return m ? (m[1] != null ? m[1] : m[2]) : ""; };
    const subs = text.split(/\r?\n/).filter((l) => /^#EXT-X-MEDIA:/.test(l) && attr(l, "TYPE") === "SUBTITLES" && attr(l, "URI") && !/^YES$/i.test(attr(l, "FORCED")))
      .map((l) => ({ lang: attr(l, "LANGUAGE"), sdh: /describes-(music|spoken)/.test(attr(l, "CHARACTERISTICS")), uri: attr(l, "URI") }));
    const byLang = (re) => subs.filter((x) => re.test(x.lang)).sort((a, b) => a.sdh - b.sdh)[0];
    const pick = byLang(/^en/i) || byLang(/^ja/i);
    if (!pick) return false;
    let pl;
    try { pl = new URL(pick.uri, url).href; } catch { return false; }
    disneyLoad(pl, pick.lang);
    return true;
  }
  async function disneyFetch(plUrl, lang) {
    const read = async (url) => {
      const r = await origFetch(url);
      noteDisney(r.url || url, r.headers.get("content-type") || "", "subtitle-fetch");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return { text: await r.text(), url: r.url || url };
    };
    const response = await read(plUrl);
    plUrl = response.url;
    const txt = response.text;
    if (!/^\s*#EXTM3U/.test(txt)) { inspect(plUrl, "", txt, { lang }); return; }
    if (/#EXT-X-MEDIA:/.test(txt)) { disneyPlaylist(plUrl, txt); return; }
    const lines = txt.split(/\r?\n/);
    const segs = [];
    let dur = 0, at = 0;
    for (const l of lines) {
      const m = l.match(/^#EXTINF:([\d.]+)/);
      if (m) { dur = parseFloat(m[1]) || 0; continue; }
      if (!l || l[0] === "#") continue;
      segs.push({ url: new URL(l.trim(), plUrl).href, start: at });
      at += dur; dur = 0;
    }
    if (!segs.length) return;
    const bodies = await Promise.all(segs.map((sg) => read(sg.url).then((r) => r.text).catch((e) => { disneyError(sg.url, e); return ""; })));
    const ts = (s) => { const m = s.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/); return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +("0." + m[4]) : 0; };
    const fmt = (t) => { const h = Math.floor(t / 3600), mi = Math.floor(t / 60) % 60, s = t % 60; return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0") + ":" + s.toFixed(3).padStart(6, "0"); };
    const out = ["WEBVTT", ""];
    // Are cue times absolute (the whole programme) or restart at 0 in every segment? Decide once from all
    // segments: a restart (a segment starting earlier than the previous one ended) means relative.
    // Never trust X-TIMESTAMP-MAP: on absolute cues it would add the offset twice and subtitles drift.
    const times = bodies.map((bd) => { const all = [...bd.matchAll(/(\S+)\s+-->\s+(\S+)/g)]; return all.length ? { f: ts(all[0][1]), l: ts(all[all.length - 1][2]) } : null; });
    let relative = false, prev = null;
    times.forEach((t, i) => { if (!t) return; if (prev && t.f + 1 < prev.l && segs[i].start > 1) relative = true; prev = t; });
    stats.disney.track = { lang, playlist: pathOnly(plUrl), segments: segs.length, timing: relative ? "relative" : "absolute",
      segFirst: times.slice(0, 6).map((t) => t && Math.round(t.f)), segStart: segs.slice(0, 6).map((x) => Math.round(x.start)) };
    postStats(true);
    segs.forEach((sg, i) => {
      const body = bodies[i] || "";
      const shift = relative ? sg.start : 0;
      for (const block of body.replace(/\r/g, "").split(/\n{2,}/)) {
        const ls = block.split("\n"), k = ls.findIndex((x) => x.includes("-->"));
        if (k < 0) continue;
        const [a, b] = ls[k].split("-->");
        out.push(fmt(ts(a) + shift) + " --> " + fmt(ts(b.trim().split(/\s/)[0]) + shift), ...ls.slice(k + 1), "");
      }
    });
    inspect(plUrl, "", out.join("\n"), { lang });
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
          const responseUrl = res.url || url;
          const canRead = readable(responseUrl, ct);
          noteDisney(responseUrl, ct, canRead ? "reading" : "skipped-binary");
          if (!canRead) return;
          res.clone().text().then((t) => inspect(responseUrl, ct, t)).catch((e) => { if (IS_DISNEY) disneyError(responseUrl, e); });
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
        const ct = this.getResponseHeader("content-type") || "";
        const url = this.responseURL || this.__psUrl;
        const canRead = readable(url, ct);
        noteDisney(url, ct, canRead ? "xhr-" + (rt || "text") : "skipped-binary");
        if (!canRead) return;
        if (!rt || rt === "text") inspect(url, ct, this.responseText);
        else if (rt === "json") inspect(url, ct, JSON.stringify(this.response));
        else if (IS_DISNEY && rt === "arraybuffer") inspect(url, ct, new TextDecoder().decode(this.response));
        else if (IS_DISNEY && rt === "blob") this.response.text().then((t) => inspect(url, ct, t)).catch((e) => disneyError(url, e));
      } catch {}
    });
    return XS.apply(this, arguments);
  };
})();
