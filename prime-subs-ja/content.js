(() => {
  const TAG = "primesubs-ja";
  const S = {
    enabled: true, hideNative: true, showEn: true, showJa: true,
    autoPause: false, hoverPause: true, offset: 0, fontSize: 28,
    subPos: "overlay" // "overlay" (on the picture) | "below" (bar under a shrunken picture)
  };
  let cues = [];          // source-language cues [{begin,end,text}]
  let tr = [];            // translations, parallel to cues
  let srcLang = "en";     // "en" | "ja" | "other"
  let cueKey = "";
  let runId = 0;
  let working = false;
  let panelOpen = false;
  let cueVideo = null;      // the <video> the loaded subtitles belong to
  let cuePath = "";         // page path they were loaded on
  let uiOn = false;         // true only while that player is on screen
  let inactiveSince = 0;
  let lastError = "";
  let lastMouse = 0;

  // ---------- settings ----------
  chrome.storage.sync.get(S).then((v) => { Object.assign(S, v); applySettings(); });
  chrome.storage.onChanged.addListener((ch) => {
    for (const k in ch) if (k in S) S[k] = ch[k].newValue;
    applySettings();
  });

  // ---------- language handling ----------
  const KANA = /[぀-ヿ]/g;
  function detectLang(attr, cueList) {
    if (/^ja/i.test(attr)) return "ja";
    if (/^en/i.test(attr)) return "en";
    if (attr) return "other";
    const sample = cueList.slice(0, 80).map((c) => c.text).join("");
    const kana = (sample.match(KANA) || []).length;
    if (kana / Math.max(1, sample.length) > 0.12) return "ja";
    return /[A-Za-z]{3}/.test(sample) ? "en" : "other";
  }
  const targetOf = () => (srcLang === "ja" ? "en" : "ja");
  const hasText = (s) => /\p{L}/u.test(s);
  const enOf = (i) => (srcLang === "ja" ? tr[i] : cues[i].text);              // English line
  const jaOf = (i) => (srcLang === "ja" ? cues[i].text : tr[i]);              // Japanese line
  const PENDING = "…";                                                        // shown while a line is still being translated
  const enLine = (i) => enOf(i) || (srcLang === "ja" ? PENDING : "");
  const jaLine = (i) => jaOf(i) || (srcLang !== "ja" ? PENDING : "");

  // ---------- receive subtitle files from the page hook ----------
  let hookStats = { scanned: 0, found: 0, recent: [] };
  window.addEventListener("message", (e) => {
    if (!extAlive()) return;
    if (e.source !== window || !e.data || e.data.source !== TAG) return;
    const d = e.data;
    if (d.type === "stat") { hookStats = d.stats; return; }
    if (d.type !== "ttml" && d.type !== "vtt") return;
    const T = globalThis.PrimeSubsTTML;
    const parsed = d.type === "vtt" ? T.parseVtt(d.text) : T.parse(d.text);
    if (!parsed.cues.length) return;
    // A tiny file next to a full one is a forced-narrative track (foreign-language lines only).
    if (cues.length > 100 && parsed.cues.length < cues.length * 0.25) return;
    const key = parsed.cues.length + ":" + parsed.cues[0].begin + ":" + parsed.cues[parsed.cues.length - 1].end;
    if (key === cueKey) return;
    cueKey = key;
    cues = parsed.cues;
    srcLang = detectLang(parsed.lang, cues);
    tr = new Array(cues.length).fill(null);
    runId++;
    cueVideo = findVideo(); cuePath = location.pathname;
    console.log(`[primesubs-ja] loaded ${cues.length} ${srcLang} cues (${d.type})`);
    buildPanelRows();
    applySettings();
    chrome.runtime.sendMessage({ type: "warm" }).catch(() => {}); // load the model now, not on the first line
    pump();
  });
  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };

  // ---------- translation scheduler (from "now" forward) ----------
  const flat = (s) => s.replace(/\n/g, " ");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function indexAt(t) {
    let lo = 0, hi = cues.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].begin <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function nextTodo() {
    const t = videoTime();
    const start = t == null ? 0 : indexAt(t);
    for (let i = 0; i < cues.length; i++) {
      const k = (start + i) % cues.length;
      if (tr[k] == null) return k;
    }
    return -1;
  }

  async function pump() {
    if (working) return;
    working = true;
    try {
      for (;;) {
        if (!S.enabled) { await sleep(500); continue; }
        const my = runId;
        const i = nextTodo();
        if (i < 0) break;
        const text = flat(cues[i].text);
        if (!hasText(text) || !/[\p{L}]{2}/u.test(text)) { tr[i] = cues[i].text; setRow(i); continue; }
        const history = [];
        for (let k = i - 1; k >= 0 && history.length < 3; k--) {
          if (tr[k] == null) break;
          if (hasText(cues[k].text)) history.unshift([flat(cues[k].text), flat(tr[k])]);
        }
        const r = await chrome.runtime.sendMessage({ type: "translate", text, history, to: targetOf() });
        if (my !== runId) continue;
        if (r && r.ok) { tr[i] = r.ja || cues[i].text; setRow(i); shown = null; lastError = ""; }
        else {
          lastError = (r && r.error) || "翻訳に失敗しました";
          console.warn("[primesubs-ja]", lastError);
          await sleep(3000);
        }
      }
    } finally { working = false; }
  }

  // ---------- video ----------
  function findVideo() {
    const vs = [...document.querySelectorAll("video")].filter((v) => v.readyState > 0);
    vs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return vs[0] || null;
  }
  function isShown(v) {
    if (!v || !v.isConnected) return false;
    const r = v.getBoundingClientRect(), cs = getComputedStyle(v);
    return r.width > 200 && r.height > 100 && cs.visibility !== "hidden" && cs.display !== "none";
  }
  // the playing <video>, only while Prime's player UI is on the page
  function playerVideo() {
    if (!document.querySelector(".atvwebplayersdk-player-container")) return null;
    if (cueVideo && isShown(cueVideo)) return cueVideo;
    const v = findVideo();
    return v && isShown(v) ? v : null;
  }
  const getVideo = () => (cueVideo && isShown(cueVideo) ? cueVideo : findVideo());
  const videoTime = () => { const v = getVideo(); return v ? v.currentTime - S.offset : null; };
  let lastSeek = 0;
  function seekTo(i, play) {
    const v = getVideo();
    if (!v || !cues[i]) return;
    v.currentTime = cues[i].begin + S.offset;
    if (play && v.paused) v.play().catch(() => {});
    lastSeek = Date.now();
  }

  // ---------- UI (Shadow DOM so Prime's CSS cannot touch it) ----------
  let host, root, subBox, enEl, jaEl, panel, list, tip, autoBtn, statusEl;
  let rowEls = [], rowEnEls = [], rowJaEls = [];
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:'Hiragino Sans','Yu Gothic',-apple-system,sans-serif}
    .sub{position:fixed;left:50%;transform:translateX(-50%);bottom:14%;max-width:78vw;text-align:center;
      pointer-events:auto;z-index:2;padding:6px 14px;border-radius:8px;background:rgba(0,0,0,.45);
      color:#fff;text-shadow:0 0 3px #000;line-height:1.4;display:none}
    .sub.open{transform:translateX(-50%) translateX(-170px)}
    .sub.below{left:0;right:0;bottom:0;transform:none;max-width:none;width:100%;border-radius:0;background:#000;
      height:18vh;display:none;flex-direction:column;justify-content:center;padding:6px 24px;transition:bottom .18s}
    .sub.below.lift{bottom:150px}
    .sub.below.open{right:340px;width:auto}
    .en{font-weight:600;white-space:pre-line}
    .ja{margin-top:2px;color:#ffe9a8;font-weight:600;white-space:pre-line}
    .w{border-radius:4px;cursor:pointer;padding:0 1px}
    .w:hover{background:rgba(255,255,255,.28)}
    .tip{position:fixed;z-index:5;background:#1b1b24;color:#fff;border:1px solid #6a5acd;border-radius:8px;
      padding:8px 12px;font-size:15px;line-height:1.5;pointer-events:none;display:none;max-width:320px;
      box-shadow:0 4px 18px rgba(0,0,0,.6)}
    .tip b{color:#c9b8ff}.tip .ph{margin-top:4px;color:#ddd;font-size:13px}
    .panel{position:fixed;top:0;right:0;bottom:0;width:340px;z-index:3;background:rgba(18,18,26,.94);
      color:#eee;display:none;flex-direction:column;pointer-events:auto;border-left:1px solid #333}
    .panel.open{display:flex}
    .ph0{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #333;font-size:13px}
    .ph0 .sp{flex:1}
    .ph0 button{background:#2b2b3a;color:#ddd;border:1px solid #444;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px}
    .ph0 button.on{background:#ffd83d;color:#16181d;border-color:#ffd83d}
    .list{flex:1;overflow-y:auto;padding:4px 0}
    .row{padding:7px 12px;cursor:pointer;border-left:3px solid transparent;font-size:13px}
    .row:hover{background:#242433}
    .row.act{background:#2a2750;border-left-color:#ffd83d}
    .row .e{color:#f1f1f1;white-space:pre-line}.row .j{color:#ffe9a8;margin-top:2px;white-space:pre-line}
    .row .e:empty::after,.row .j:empty::after{content:'…';color:#666}
    .keys{padding:6px 12px;border-top:1px solid #333;color:#888;font-size:11px}
    .status{padding:6px 12px;border-bottom:1px solid #333;color:#bbb;font-size:12px}
    .empty{padding:18px 14px;color:#ddd;font-size:13px;line-height:1.7}
    .diag{margin-top:6px;background:#2b2b3a;color:#ddd;border:1px solid #444;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer}
  `;

  function ensureUI() {
    if (!host) {
      host = document.createElement("div");
      host.id = "primesubs-ja-host";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${CSS}</style>
        <div class="sub"><div class="en"></div><div class="ja"></div></div>
        <div class="tip"></div>
        <div class="panel">
          <div class="ph0"><b>字幕</b><span class="sp"></span>
            <button class="auto" title="セリフごとに止める (P)">自動停止</button>
            <button class="x">✕</button></div>
          <div class="status"></div>
          <div class="list"></div>
          <div class="keys">A 前 / S もう一度 / D 次 / P 自動停止 / T 一覧<br>訳は PLaMo 3 Translate による機械翻訳（Built with PLaMo）<br><button class="diag" title="うまく動かないとき、この情報を開発者に送ってください">診断情報をコピー</button></div>
        </div>`;
      subBox = root.querySelector(".sub");
      enEl = root.querySelector(".en");
      jaEl = root.querySelector(".ja");
      tip = root.querySelector(".tip");
      panel = root.querySelector(".panel");
      list = root.querySelector(".list");
      autoBtn = root.querySelector(".auto");
      statusEl = root.querySelector(".status");
      root.querySelector(".diag").onclick = copyDiag;
      root.querySelector(".x").onclick = () => setPanel(false);
      autoBtn.onclick = () => chrome.storage.sync.set({ autoPause: !S.autoPause });
      list.addEventListener("click", (e) => {
        const r = e.target.closest(".row");
        if (r) seekTo(+r.dataset.i, true);
      });
      list.addEventListener("wheel", () => { list.__userScroll = Date.now(); }, { passive: true });
      buildPanelRows();
      applySettings();
    }
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (host.parentElement !== parent) parent.appendChild(host);
    return host;
  }

  function setPanel(open) {
    panelOpen = open;
    ensureUI();
    panel.classList.toggle("open", open);
    subBox.classList.toggle("open", open);
    if (launcherBtn) launcherBtn.classList.toggle("on", open);
    if (open) lastActRow = -1;
  }

  function buildPanelRows() {
    if (!list) return;
    const frag = document.createDocumentFragment();
    rowEls = []; rowEnEls = []; rowJaEls = [];
    cues.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "row"; row.dataset.i = i;
      const e = document.createElement("div"); e.className = "e";
      const j = document.createElement("div"); j.className = "j";
      row.append(e, j); frag.appendChild(row);
      rowEls.push(row); rowEnEls.push(e); rowJaEls.push(j);
      fillRow(i);
    });
    if (!cues.length) {
      const em = document.createElement("div"); em.className = "empty";
      em.textContent = "Prime Video の字幕ファイルを検出できていません。字幕を「英語」（なければ日本語）にして、このタブを再読み込みしてください。それでも出ないときは、下の「診断情報をコピー」を押して内容を教えてください。";
      frag.appendChild(em);
    }
    list.replaceChildren(frag);
    lastActRow = -1;
  }
  function fillRow(i) {
    if (!rowEnEls[i]) return;
    rowEnEls[i].textContent = enOf(i) || "";
    rowJaEls[i].textContent = jaOf(i) || "";
  }
  const setRow = (i) => fillRow(i);

  // ---------- launcher button: sits next to Prime's own subtitle button ----------
  let btnHost = null, launcherBtn = null, btnPlaced = "", capSeen = false;
  const BTN_CSS = `
    :host{all:initial}
    button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:7px;height:34px;
      padding:0 13px 0 7px;margin:0 12px 0 0;border-radius:999px;background:#ffd83d;color:#16181d;pointer-events:auto;
      font:700 14px/1 'Hiragino Sans',-apple-system,sans-serif;letter-spacing:.02em;box-shadow:0 0 0 2px rgba(0,0,0,.35);
      transition:filter .12s,transform .12s;white-space:nowrap}
    button:hover{filter:brightness(1.1);transform:translateY(-1px)}
    button:focus-visible{outline:2px solid #fff;outline-offset:2px}
    svg{flex:none;display:block}
    button.on{background:#16181d;color:#ffd83d;box-shadow:0 0 0 2px #ffd83d}
    button.warn{background:#ff9f43}
    :host(.float) button{position:fixed;top:14px;right:300px;transition:opacity .25s}
    :host(.hide) button{opacity:0;pointer-events:none}
  `;
  const BTN_ICON = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><rect width="22" height="22" rx="6" fill="#16181d"/><rect x="4" y="7.5" width="14" height="2.6" rx="1.3" fill="#fff"/><rect x="4" y="12" width="14" height="2.6" rx="1.3" fill="#ffd83d"/></svg>';
  function makeLauncher() {
    btnHost = document.createElement("div");
    btnHost.id = "primesubs-ja-btn";
    btnHost.style.cssText = "display:contents";
    const r = btnHost.attachShadow({ mode: "open" });
    r.innerHTML = `<style>${BTN_CSS}</style><button title="Dual Subs JA：セリフ一覧を開く (T)" aria-label="Dual Subs JA：セリフ一覧を開く">${BTN_ICON}<span>JA</span></button>`;
    launcherBtn = r.querySelector("button");
    launcherBtn.addEventListener("click", (e) => { e.stopPropagation(); setPanel(!panelOpen); });
    launcherBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  }
  // Prime's markup uses generated class names, so find the button by its accessible label.
  const CAPTION_LABEL = /字幕|subtitle|caption|closed/i;
  function findCaptionButton() {
    const scope = document.querySelector(".atvwebplayersdk-player-container") || document;
    const cands = [...scope.querySelectorAll("button, [role=button]")].filter((b) => {
      if (b.closest("#primesubs-ja-btn")) return false;
      const label = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "");
      if (!CAPTION_LABEL.test(label)) return false;
      const rc = b.getBoundingClientRect();
      return rc.width > 16 && rc.width < 120 && rc.top < innerHeight * 0.5; // the top control bar, not menu items
    });
    return cands[0] || null;
  }
  // Climb from the caption button to the element that sits in the horizontal row of control buttons
  // (volume, PiP, fullscreen, ...). Putting ours in that row keeps it level with them and clickable.
  function findRowSlot(btn) {
    for (let el = btn; el && el.parentElement && el !== document.body; el = el.parentElement) {
      const p = el.parentElement;
      const kids = [...p.children].filter((k) => k.id !== "primesubs-ja-btn" && k.getBoundingClientRect().width > 0);
      if (kids.length >= 3) {
        const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top / 12));
        const aligned = tops.filter((t) => t === tops[0]).length >= Math.ceil(kids.length * 0.6);
        if (aligned || kids.length >= 4) return { parent: p, ref: el };
      }
    }
    return { parent: btn.parentElement, ref: btn };
  }
  function placeLauncher(show, warn) {
    if (!btnHost) makeLauncher();
    launcherBtn.classList.toggle("warn", !!warn);
    if (!show) { btnHost.remove(); btnPlaced = ""; return; }
    const cap = findCaptionButton();
    if (cap) {
      capSeen = true;
      const slot = findRowSlot(cap);
      if (btnHost.parentElement !== slot.parent || btnHost.nextElementSibling !== slot.ref) slot.parent.insertBefore(btnHost, slot.ref);
      btnHost.classList.remove("float", "hide");
      btnPlaced = "inline";
      return;
    }
    // No caption button right now. If we have seen it before, Prime has hidden its controls: hide ours too.
    if (capSeen) { btnHost.remove(); btnPlaced = "hidden"; return; }
    // Never found (the page labels it differently): float it, but only while the controls would be showing
    // (mouse moved recently, or playback is paused), like Prime's own controls.
    const v = getVideo();
    const controlsUp = Date.now() - lastMouse < 3000 || (v && v.paused);
    const parent = document.fullscreenElement || document.body;
    if (btnHost.parentElement !== parent) parent.appendChild(btnHost);
    btnHost.classList.add("float");
    btnHost.classList.toggle("hide", !controlsUp);
    btnPlaced = "float";
  }

  // ---------- settings -> DOM ----------
  let nativeStyle = null, shrinkStyle = null;
  function applySettings() {
    const hasCues = cues.length > 0;
    if (!nativeStyle) {
      nativeStyle = document.createElement("style");
      shrinkStyle = document.createElement("style");
      (document.head || document.documentElement).append(nativeStyle, shrinkStyle);
    }
    nativeStyle.textContent = S.enabled && uiOn && S.hideNative && hasCues
      ? "[class*=\"atvwebplayersdk-captions\"],[class*=\"atvwebplayersdk-subtitle\"]{visibility:hidden !important}"
      : "";
    // Best effort: shrink the picture to leave room for the bar below it.
    shrinkStyle.textContent = S.enabled && uiOn && S.subPos === "below" && hasCues
      ? "video,.atvwebplayersdk-video-surface{height:calc(100% - 18vh) !important}"
      : "";
    if (host) {
      enEl.style.fontSize = Math.round(S.fontSize * 0.85) + "px";
      jaEl.style.fontSize = S.fontSize + "px";
      autoBtn.classList.toggle("on", S.autoPause);
      subBox.classList.toggle("below", S.subPos === "below");
    }
    shown = null;
  }

  // ---------- hover dictionary ----------
  const wordCache = new Map();
  async function lookup(word, sentence, idx, tokens) {
    const a = Math.max(0, idx - 2), b = Math.min(tokens.length, idx + 3);
    const phrase = tokens.slice(a, b).join(" ");
    const get = async (t) => {
      if (wordCache.has(t)) return wordCache.get(t);
      const r = await chrome.runtime.sendMessage({ type: "word", word: t, sentence });
      const v = r && r.ok ? r.ja : "?";
      wordCache.set(t, v);
      return v;
    };
    const w = await get(word);
    const p = phrase !== word ? await get(phrase) : "";
    return { w, phrase: phrase !== word ? phrase : "", p };
  }

  let hoverToken = 0, hoverPaused = false;
  function onWordEnter(span, sentence, tokens, idx) {
    const my = ++hoverToken;
    const word = span.textContent;
    const rect = span.getBoundingClientRect();
    tip.style.display = "block";
    tip.textContent = "";
    const b = document.createElement("b"); b.textContent = word;
    const body = document.createElement("span"); body.textContent = "  …";
    tip.append(b, body);
    const place = () => {
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, rect.left + rect.width / 2 - tw / 2)) + "px";
      tip.style.top = Math.max(8, rect.top - th - 8) + "px";
    };
    place();
    const v = findVideo();
    if (S.hoverPause && v && !v.paused) { v.pause(); hoverPaused = true; }
    lookup(word, sentence, idx, tokens).then((res) => {
      if (my !== hoverToken) return;
      body.textContent = "  → " + res.w;
      if (res.phrase) {
        const ph = document.createElement("div"); ph.className = "ph";
        ph.textContent = res.phrase + " → " + res.p;
        tip.appendChild(ph);
      }
      place();
    });
  }
  function onWordLeave() {
    hoverToken++;
    tip.style.display = "none";
    const v = findVideo();
    if (hoverPaused && v && v.paused) v.play().catch(() => {});
    hoverPaused = false;
  }

  function renderEnglish(text) {
    enEl.textContent = "";
    const tokens = text.split(/\s+/).map((t) => t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")).filter(Boolean);
    let wi = 0;
    text.split(/([A-Za-z][A-Za-z'’-]*)/).forEach((part) => {
      if (!part) return;
      if (/^[A-Za-z]/.test(part)) {
        const s = document.createElement("span");
        s.className = "w"; s.textContent = part;
        const idx = Math.min(wi++, tokens.length - 1);
        s.addEventListener("mouseenter", () => onWordEnter(s, text.replace(/\n/g, " "), tokens, idx));
        s.addEventListener("mouseleave", onWordLeave);
        enEl.appendChild(s);
      } else enEl.appendChild(document.createTextNode(part));
    });
  }

  // ---------- DOM caption fallback (when no subtitle file was captured) ----------
  const domCache = new Map();
  let domBusy = false;
  async function domFallback() {
    const els = [...document.querySelectorAll(".atvwebplayersdk-captions-text")];
    const text = els.map((n) => n.innerText).join(" ").trim();
    if (!text || !/[A-Za-z]/.test(text)) return "";
    if (domCache.has(text)) return domCache.get(text);
    if (!domBusy) {
      domBusy = true;
      const r = await chrome.runtime.sendMessage({ type: "translate", text, history: [], to: "ja" });
      domBusy = false;
      if (r && r.ok) { domCache.set(text, r.ja); if (domCache.size > 200) domCache.delete(domCache.keys().next().value); }
    }
    return domCache.get(text) || "";
  }

  // ---------- status + diagnostics ----------
  function statusText() {
    if (!cues.length) return "字幕ファイル: 未検出（読み取り済みの通信 " + hookStats.scanned + " 件）";
    const done = tr.filter((x) => x != null).length;
    if (lastError) return "⚠ 翻訳できません: " + lastError;
    const t0 = videoTime(); const cur = t0 == null ? 0 : indexAt(t0);
    let ahead = 0; while (cur + ahead < cues.length && tr[cur + ahead] != null) ahead++;
    return `先読み ${ahead} 行 ／ 字幕 ${cues.length} 行（${srcLang === "ja" ? "日本語→英語に翻訳" : srcLang === "en" ? "英語→日本語に翻訳" : "外国語→日本語に翻訳"}）／ 翻訳済み ${done}/${cues.length}`;
  }
  function nativeCaptionCandidates() {
    const out = [];
    for (const el of document.querySelectorAll("div,span,p")) {
      if (el.children.length || el.closest("#primesubs-ja-host,#primesubs-ja-btn")) continue;
      if (!el.textContent.trim() || el.textContent.trim().length < 3) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.top < innerHeight * 0.5 || r.bottom > innerHeight * 0.95) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const chain = []; let p = el;
      for (let k = 0; k < 4 && p; k++, p = p.parentElement) chain.push((p.tagName || "").toLowerCase() + "." + String(p.className || "").slice(0, 70));
      out.push({ chain, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
      if (out.length >= 6) break;
    }
    return out;
  }
  function diagnostics() {
    const vids = [...document.querySelectorAll("video")].map((v) => ({ ready: v.readyState, w: Math.round(v.getBoundingClientRect().width), h: Math.round(v.getBoundingClientRect().height), paused: v.paused, t: Math.round(v.currentTime) }));
    return {
      version: chrome.runtime.getManifest().version, path: location.pathname,
      cues: { n: cues.length, src: srcLang, translated: tr.filter((x) => x != null).length, first: cues[0] && [cues[0].begin, cues[0].end], last: cues.length && [cues[cues.length - 1].begin, cues[cues.length - 1].end] },
      ui: { uiOn, panelOpen, launcher: btnPlaced, captionButtonFound: !!findCaptionButton(), playerContainer: !!document.querySelector(".atvwebplayersdk-player-container") },
      hook: hookStats, videos: vids, nativeCaptionCandidates: nativeCaptionCandidates(),
      settings: S
    };
  }
  async function copyDiag() {
    const btn = root.querySelector(".diag");
    try { await navigator.clipboard.writeText(JSON.stringify(diagnostics(), null, 1)); btn.textContent = "コピーしました"; }
    catch (e) { btn.textContent = "コピーできませんでした"; console.log("[primesubs-ja] diagnostics", diagnostics()); }
    setTimeout(() => (btn.textContent = "診断情報をコピー"), 2500);
  }

  // ---------- leaving the player ----------
  function setUiOn(on) { if (uiOn !== on) { uiOn = on; applySettings(); } }
  function resetState() {
    cues = []; tr = []; cueKey = ""; cueVideo = null; runId++;
    panelOpen = false;
    if (panel) { panel.classList.remove("open"); subBox.classList.remove("open"); }
    buildPanelRows();
    shown = null; prevActive = -1; lastActRow = -1;
    setUiOn(false);
  }

  // ---------- main loop ----------
  let shown = null, prevActive = -1, lastActRow = -1, lastStatus = 0;
  addEventListener("mousemove", () => { lastMouse = Date.now(); }, { passive: true, capture: true });

  async function tick() {
    if (!extAlive()) { teardown(); return; }   // the extension was updated/reloaded: this page's copy is stale
    ensureUI();
    if (statusEl && Date.now() - lastStatus > 800) { statusEl.textContent = statusText(); lastStatus = Date.now(); }
    if (cues.length) {
      // The subtitles belong to one page. Prime may swap its <video> element during playback, so re-bind to
      // the live one while the player is open instead of treating that as "player closed".
      const samePage = location.pathname === cuePath;
      const live = samePage ? playerVideo() : null;
      if (live) cueVideo = live;
      if (!live) {
        if (!inactiveSince) inactiveSince = Date.now();
        setUiOn(false); placeLauncher(false); subBox.style.display = "none"; tip.style.display = "none";
        // wipe the loaded subtitles only after we really left the page (or sat away from the player a long time)
        if ((!samePage && Date.now() - inactiveSince > 2000) || Date.now() - inactiveSince > 10 * 60 * 1000) { resetState(); inactiveSince = 0; }
        return;
      }
      inactiveSince = 0;
      setUiOn(true);
    }
    const v = getVideo();
    const present = !!v && (cues.length > 0 || !!document.querySelector(".atvwebplayersdk-player-container"));
    placeLauncher(S.enabled && present, cues.length === 0 || !!lastError);   // orange while no subtitle file has been captured
    if (!S.enabled || !v) { subBox.style.display = "none"; return; }
    const t = v.currentTime - S.offset;
    subBox.classList.toggle("lift", S.subPos === "below" && Date.now() - lastMouse < 2800);

    let enText = "", jaText = "", act = -1;
    if (cues.length) {
      const i = indexAt(t);
      const actives = [];
      for (let k = Math.max(0, i - 3); k <= Math.min(cues.length - 1, i + 1); k++) {
        if (cues[k].begin <= t && t < cues[k].end) actives.push(k);
      }
      act = actives.length ? actives[0] : -1;
      enText = actives.map((k) => enLine(k)).filter(Boolean).join("\n");
      jaText = actives.map((k) => jaLine(k)).filter(Boolean).join("\n");

      // auto-pause when the line that was playing has just ended (not after a seek)
      if (S.autoPause && prevActive >= 0 && act !== prevActive && !v.paused && Date.now() - lastSeek > 700) {
        const dt = t - cues[prevActive].end;
        if (dt >= -0.2 && dt < 0.8) v.pause();
      }
      prevActive = act;

      if (panelOpen && act !== lastActRow) {
        if (lastActRow >= 0 && rowEls[lastActRow]) rowEls[lastActRow].classList.remove("act");
        if (act >= 0 && rowEls[act]) {
          rowEls[act].classList.add("act");
          if (Date.now() - (list.__userScroll || 0) > 3000) rowEls[act].scrollIntoView({ block: "center", behavior: "smooth" });
        }
        lastActRow = act;
      }
    } else {
      jaText = await domFallback();
    }

    const key = enText + "\u0001" + jaText;
    if (key !== shown) {
      shown = key;
      if (S.showEn && enText) renderEnglish(enText); else enEl.textContent = "";
      jaEl.textContent = S.showJa ? jaText : "";
      const any = (S.showEn && enText) || (S.showJa && jaText);
      subBox.style.display = any ? (S.subPos === "below" ? "flex" : "block") : "none";
    }
  }
  const timers = [
    setInterval(() => tick().catch(() => {}), 100),
    setInterval(() => { if (extAlive() && cues.length && !working) pump(); }, 2000)
  ];
  function teardown() {
    timers.forEach(clearInterval);
    for (const el of [host, btnHost, nativeStyle, shrinkStyle]) if (el) el.remove();
    runId++;
  }
  document.addEventListener("fullscreenchange", () => { host && ensureUI(); btnHost && btnHost.remove(); });

  // ---------- keyboard ----------
  window.addEventListener("keydown", (e) => {
    if (!extAlive() || !S.enabled || !cues.length || e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
    const k = e.key.toLowerCase();
    const t = videoTime();
    if (t == null) return;
    const i = indexAt(t);
    let handled = true;
    if (k === "a") seekTo(t - cues[i].begin > 1.2 ? i : Math.max(0, i - 1), true);
    else if (k === "s") seekTo(cues[i].end > t ? i : Math.max(0, i), true);
    else if (k === "d") seekTo(Math.min(cues.length - 1, cues[i].begin <= t ? i + 1 : i), true);
    else if (k === "p") chrome.storage.sync.set({ autoPause: !S.autoPause });
    else if (k === "t") setPanel(!panelOpen);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
})();
