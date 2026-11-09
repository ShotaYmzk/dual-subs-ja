// Minimal TTML/DFXP parser (no DOM needed, so it also runs under node for tests).
(function (root) {
  function decode(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  function attr(tag, name) {
    const m = tag.match(new RegExp("(?:^|\\s)(?:[\\w-]+:)?" + name + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : null;
  }

  function parseTime(v, ctx) {
    if (v == null) return null;
    v = v.trim();
    let m;
    if ((m = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/))) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
    if ((m = v.match(/^(\d+):(\d+):(\d+):(\d+)$/))) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / ctx.frameRate;
    if ((m = v.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/))) {
      const n = parseFloat(m[1]);
      switch (m[2]) {
        case "h": return n * 3600;
        case "m": return n * 60;
        case "s": return n;
        case "ms": return n / 1000;
        case "f": return n / ctx.frameRate;
        case "t": return n / ctx.tickRate;
      }
    }
    return null;
  }

  function looksLikeTTML(text) {
    return typeof text === "string" && /<tt[\s>]/.test(text.slice(0, 2000)) && /<p[\s>]/.test(text);
  }

  // Returns { lang, cues: [{begin, end, text}] } sorted by begin.
  function parse(xml) {
    const head = xml.match(/<tt[\s>][^>]*>/);
    const headTag = head ? head[0] : "";
    const frameRate = parseFloat(attr(headTag, "frameRate")) || 24;
    const tickRate = parseFloat(attr(headTag, "tickRate")) || 10000000;
    const lang = attr(headTag, "lang") || "";
    const ctx = { frameRate, tickRate };
    const cues = [];
    const re = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(xml))) {
      const open = "<p" + (m[1] || "") + ">";
      const begin = parseTime(attr(open, "begin"), ctx);
      let end = parseTime(attr(open, "end"), ctx);
      const dur = parseTime(attr(open, "dur"), ctx);
      if (end == null && begin != null && dur != null) end = begin + dur;
      if (begin == null || end == null) continue;
      const text = decode(
        m[2]
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
      )
        .split("\n")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
      if (text) cues.push({ begin, end, text });
    }
    cues.sort((a, b) => a.begin - b.begin);
    return { lang, cues };
  }

  function parseVtt(text) {
    const toSec = (s) => {
      const m = s.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
      return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +("0." + m[4]) : null;
    };
    const cues = [];
    for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n");
      const k = lines.findIndex((l) => l.includes("-->"));
      if (k < 0) continue;
      const [a, b] = lines[k].split("-->");
      const begin = toSec(a.trim()), end = toSec(b.trim().split(/\s/)[0]);
      if (begin == null || end == null) continue;
      const body = decode(lines.slice(k + 1).join("\n").replace(/<[^>]+>/g, ""))
        .split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      if (body) cues.push({ begin, end, text: body });
    }
    cues.sort((x, y) => x.begin - y.begin);
    return { lang: "", cues };
  }

  // ---- YouTube ----
  function tidy(cues) {
    cues.sort((a, b) => a.begin - b.begin);
    const out = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i], n = cues[i + 1];
      if (n && c.end > n.begin) c.end = n.begin;           // rolling auto-captions overlap: cut at the next one
      if (c.end - c.begin < 0.05) continue;
      if (out.length && out[out.length - 1].text === c.text) { out[out.length - 1].end = Math.max(out[out.length - 1].end, c.end); continue; }
      out.push(c);
    }
    return out;
  }
  function parseJson3(text) {
    let d;
    try { d = JSON.parse(text); } catch { return { lang: "", cues: [] }; }
    const cues = [];
    for (const e of d.events || []) {
      if (!e.segs || e.tStartMs == null) continue;
      const raw = e.segs.map((s) => s.utf8 || "").join("").replace(/\u200b/g, "");
      const lines = raw.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
      if (!lines.length) continue;
      cues.push({ begin: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000, text: lines.join("\n") });
    }
    return { lang: "", cues: tidy(cues) };
  }
  function parseYtXml(text) {
    const dec2 = (s) => decode(decode(s));
    const cues = [];
    let m;
    const reP = /<p\s+([^>]*?)>([\s\S]*?)<\/p>/g;                       // srv3: <p t="ms" d="ms">…<s>…</s></p>
    while ((m = reP.exec(text))) {
      const t = attr("<p " + m[1] + ">", "t"), d = attr("<p " + m[1] + ">", "d");
      if (t == null) continue;
      const body = dec2(m[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
      const lines = body.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
      if (lines.length) cues.push({ begin: +t / 1000, end: (+t + (+d || 2000)) / 1000, text: lines.join("\n") });
    }
    if (!cues.length) {
      const reT = /<text\s+([^>]*?)>([\s\S]*?)<\/text>/g;               // classic: <text start="s" dur="s">…</text>
      while ((m = reT.exec(text))) {
        const st = attr("<text " + m[1] + ">", "start"), du = attr("<text " + m[1] + ">", "dur");
        if (st == null) continue;
        const body = dec2(m[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
        const lines = body.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (lines.length) cues.push({ begin: +st, end: +st + (+du || 2), text: lines.join("\n") });
      }
    }
    return { lang: "", cues: tidy(cues) };
  }
  function parseYouTube(text) {
    return /^\s*\{/.test(text) ? parseJson3(text) : parseYtXml(text);
  }

  const api = { parse, parseVtt, parseJson3, parseYtXml, parseYouTube, looksLikeTTML };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PrimeSubsTTML = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
