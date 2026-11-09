let S = {};
const TOGGLES = ["enabled", "hideNative", "autoPause", "hoverPause"];
const BROWSER_OK = (m) => m.browser;
const RELOAD_KEYS = ["endpoint", "keepAlive", "engine", "mode"];

function dispModeOf(s) { return s.showEn && s.showJa ? "both" : s.showJa ? "ja" : "en"; }

function paint() {
  for (const k of TOGGLES) $(k).checked = !!S[k];
  document.querySelectorAll(".seg").forEach((seg) => {
    const k = seg.dataset.key;
    const cur = k === "dispMode" ? dispModeOf(S) : String(S[k] ?? "");
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === cur)));
  });
  $("fontSize").value = S.fontSize; $("fontOut").textContent = S.fontSize + "px";
  $("offsetOut").textContent = ((S.offset || 0) > 0 ? "+" : "") + (S.offset || 0).toFixed(1) + " 秒";
  $("endpoint").value = S.endpoint || "";
  const b = S.engine !== "ollama";
  $("rowMode").style.display = b ? "" : "none";
  $("rowEndpoint").style.display = b ? "none" : "";
  // live preview
  const en = $("pvEn"), ja = $("pvJa");
  en.style.display = S.showEn ? "" : "none"; ja.style.display = S.showJa ? "" : "none";
  ja.style.fontSize = S.fontSize * 0.62 + "px"; en.style.fontSize = S.fontSize * 0.62 * 0.85 + "px";
  $("pvNative").style.display = S.hideNative ? "none" : "";
  $("screen").classList.toggle("below", S.subPos === "below");
}
async function setPref(patch) {
  Object.assign(S, patch);
  paint();
  await chrome.storage.sync.set(patch);
  if (Object.keys(patch).some((k) => RELOAD_KEYS.includes(k))) { send({ type: "unload" }).catch(() => {}); refreshAll(); }
}
async function load() {
  S = await chrome.storage.sync.get(null);
  $("glossary").value = (await chrome.storage.local.get("glossary")).glossary || "";
  paint();
}
for (const k of TOGGLES) $(k).addEventListener("change", () => setPref({ [k]: $(k).checked }));
document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const k = seg.dataset.key, v = b.dataset.v;
  if (k === "dispMode") setPref({ showEn: v !== "ja", showJa: v !== "en" }); else setPref({ [k]: v });
}));
$("fontSize").addEventListener("input", () => setPref({ fontSize: Number($("fontSize").value) }));
document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
  setPref({ offset: Math.round(((S.offset || 0) + Number(b.dataset.step)) * 10) / 10 });
}));
$("endpoint").addEventListener("change", () => setPref({ endpoint: $("endpoint").value.trim() }));
let gT;
$("glossary").addEventListener("input", () => {
  clearTimeout(gT);
  gT = setTimeout(() => chrome.storage.local.set({ glossary: $("glossary").value }), 400);
});
$("csvIn").onclick = () => $("csvFile").click();
$("csvFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const txt = (await f.text()).replace(/^﻿/, "");
  const cur = $("glossary").value.trim();
  $("glossary").value = (cur ? cur + "\n" : "") + txt.trim();
  await chrome.storage.local.set({ glossary: $("glossary").value });
  e.target.value = "";
};
$("csvOut").onclick = () => {
  const blob = new Blob(["﻿" + $("glossary").value], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "glossary.csv"; a.click();
  URL.revokeObjectURL(a.href);
};

// ---- models ----
function modelRow(m, { have, inUse, onUse, onDelete, onDownload, canDownload }) {
  const row = document.createElement("div"); row.className = "row"; row.style.flexWrap = "wrap";
  const l = document.createElement("div"); l.className = "l";
  const t = document.createElement("div"); t.append(m.name + "  ");
  const sz = document.createElement("span"); sz.className = "badge"; sz.textContent = fmtBytes(m.size); t.append(sz, " ");
  if (inUse) { const b = document.createElement("span"); b.className = "badge use"; b.textContent = "使用中"; t.append(b); }
  else if (have) { const b = document.createElement("span"); b.className = "badge in"; b.textContent = "取得済み"; t.append(b); }
  const small = document.createElement("small"); small.textContent = m.note;
  l.append(t, small);
  const btns = document.createElement("div"); btns.style.display = "flex"; btns.style.gap = "8px";
  const bar = document.createElement("div"); bar.className = "bar"; bar.style.width = "100%"; bar.append(document.createElement("i"));
  const stat = document.createElement("div"); stat.className = "stat"; stat.style.width = "100%";
  if (have) {
    if (!inUse) { const u = document.createElement("button"); u.className = "act"; u.textContent = "使う"; u.onclick = onUse; btns.append(u); }
    const d = document.createElement("button"); d.textContent = "消す"; d.className = "dng";
    d.onclick = () => { if (confirm(`${m.name} を削除しますか？（${fmtBytes(m.size)} を解放します）`)) onDelete(); };
    btns.append(d);
  } else if (canDownload) {
    const dl = document.createElement("button"); dl.textContent = "取得する"; dl.className = "pri";
    dl.onclick = async () => {
      dl.disabled = true;
      try { await onDownload(bar, stat); } catch (e) { stat.textContent = "失敗: " + e.message; dl.disabled = false; }
    };
    btns.append(dl);
  }
  row.append(l, btns, bar, stat);
  return row;
}

let renderSeq = 0;
async function renderModels() {
  const seq = ++renderSeq;
  const box = $("models");
  const frag = document.createDocumentFragment();
  const done = (note) => { if (seq !== renderSeq) return; box.replaceChildren(frag); const old = $("modelNote"); if (old) old.remove(); if (note) box.after(note); };
  if (S.engine === "ollama") {
    const r = await send({ type: "tags" });
    $("modelErr").textContent = r.ok ? "" : "Ollama に接続できません: " + r.error;
    const installed = r.ok ? r.models : [];
    for (const m of CATALOG) {
      frag.append(modelRow(m, {
        have: !!installed.find((x) => same(x.name, m.ollama)), inUse: same(S.model, m.ollama), canDownload: r.ok,
        onUse: async () => { await chrome.storage.sync.set({ model: m.ollama }); S.model = m.ollama; renderModels(); refreshDiag(); },
        onDelete: async () => { const d = await send({ type: "delete", model: m.ollama }); if (!d.ok) alert(d.error); renderModels(); },
        onDownload: async (bar, stat) => { await pullModel(m.ollama, bindProgress(bar, stat)); renderModels(); }
      }));
    }
    done(); return;
  }
  const installed = await ModelStore.installed();
  $("modelErr").textContent = "";
  for (const m of CATALOG.filter(BROWSER_OK)) {
    frag.append(modelRow(m, {
      have: installed.includes(m.key), inUse: S.browserModel === m.key, canDownload: true,
      onUse: async () => { await chrome.storage.sync.set({ browserModel: m.key }); S.browserModel = m.key; send({ type: "unload" }).catch(() => {}); renderModels(); refreshDiag(); },
      onDelete: async () => { await ModelStore.remove(m.key); renderModels(); },
      onDownload: async (bar, stat) => {
        await downloadBrowserModel(m.key, bar, stat);
        if (!installed.length) { await chrome.storage.sync.set({ browserModel: m.key }); S.browserModel = m.key; }
        renderModels();
      }
    }));
  }
  const note = document.createElement("div"); note.className = "hint"; note.id = "modelNote";
  note.textContent = "モデルはこのブラウザの中に保存されます。取得中はこのタブを開いたままにしてください。";
  done(note);
}

// ---- diagnostics ----
async function refreshDiag() {
  const set = (id, t) => ($(id).textContent = t);
  if (S.engine === "ollama") {
    const v = await send({ type: "version" });
    set("dBackend", "Ollama"); set("dVer", v.ok ? "Ollama v" + v.version + "（接続OK）" : "接続できません: " + v.error);
    set("dThreads", "—");
    const p = await send({ type: "ps" });
    if (p.ok && p.models.length) {
      set("dLoaded", p.models.map((x) => x.name).join(", "));
      set("dProc", p.models.map((x) => {
        const gpu = x.size ? Math.round(((x.size_vram || 0) / x.size) * 100) : 0;
        return gpu >= 100 ? "100% GPU" : gpu > 0 ? `${gpu}% GPU / ${100 - gpu}% CPU` : "CPU";
      }).join(", "));
    } else { set("dLoaded", p.ok ? "なし（翻訳時に読み込まれます）" : "—"); set("dProc", "—"); }
    return;
  }
  const r = await send({ type: "engineStatus" });
  if (!r.ok) { set("dBackend", "—"); set("dVer", "エンジンを起動できません: " + r.error); return; }
  const st = r.state;
  set("dBackend", st.loaded ? st.backend : "まだ読み込んでいません（最初の翻訳で読み込みます）");
  set("dVer", "ブラウザ内蔵（llama.cpp WebAssembly）" + (st.error ? " / エラー: " + st.error : ""));
  set("dThreads", st.loaded ? String(st.threads) : "—");
  set("dLoaded", st.loaded ? "PLaMo 3 Translate " + st.key.toUpperCase() : "なし");
  set("dProc", (r.gpuProbe.ok ? "GPU: " + (r.gpuProbe.name || "利用可") : "GPU 利用不可（" + r.gpuProbe.reason + "）") + " / 分離コンテキスト: " + (r.isolated ? "有効" : "無効") + " / 論理コア " + r.cores);
}
$("refresh").onclick = refreshAll;
$("warm").onclick = async () => {
  const b = $("warm"); b.disabled = true; b.textContent = "読み込み中…";
  const r = await send({ type: "warm" });
  b.disabled = false; b.textContent = "モデルを読み込む";
  if (!r.ok) alert("読み込めませんでした: " + r.error);
  refreshDiag();
};
$("unload").onclick = async () => { await send({ type: "unload" }); refreshDiag(); };
const fmtSec = (ms) => (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " 秒";
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
$("benchSuite").onclick = async () => {
  const btn = $("benchSuite"); btn.disabled = true;
  $("benchBox").hidden = false; $("benchRows").textContent = ""; $("benchSummary").textContent = "測定中です…（最初はモデルの読み込みが入るので少し待ちます）";
  const r = await send({ type: "benchSuite" });
  btn.disabled = false;
  if (!r.ok) { $("benchSummary").textContent = "うまく測れませんでした: " + r.error; return; }
  const rows = r.rows, maxMs = Math.max(...rows.map((x) => x.ms));
  for (const x of rows) {
    const d = document.createElement("div"); d.className = "brow";
    d.innerHTML = '<div class="h"><b></b><span class="t"></span></div><div class="e"></div><div class="j"></div><div class="meter"><i></i></div>';
    d.querySelector("b").textContent = x.label + "（" + x.en.split(/\s+/).length + "語）";
    d.querySelector(".t").textContent = fmtSec(x.ms) + (x.tokPerSec ? " ・ " + x.tokPerSec.toFixed(0) + " トークン/秒" : "");
    d.querySelector(".e").textContent = x.en; d.querySelector(".j").textContent = x.ja;
    d.querySelector(".meter > i").style.width = Math.max(3, (x.ms / maxMs) * 100) + "%";
    $("benchRows").append(d);
  }
  // a typical subtitle line is the two shorter samples; a film has about 1,400 lines and a line lasts about 2.5 s on screen
  const line = (rows[0].ms + rows[1].ms) / 2, cueSec = 2.5, cues = 1400;
  const ahead = cueSec / (line / 1000);
  $("benchSummary").innerHTML = "";
  const p = (t) => { const d = document.createElement("div"); d.innerHTML = t; $("benchSummary").append(d); };
  p(`ふつうのセリフ1つ：<b>${fmtSec(line)}</b>（読み込み済みの状態）`);
  p(ahead >= 1 ? `再生の約<b>${ahead.toFixed(1)}倍</b>の速さで先読みできます。1〜2セリフ先なら、字幕が出るまでに十分間に合います。` : `再生より遅い訳しかできません（約<b>${ahead.toFixed(1)}倍</b>）。より小さいモデルか、GPU に切り替えると改善します。`);
  p(`約${cues.toLocaleString()}セリフの映画を最初から最後まで訳すと、およそ<b>${Math.round((line * cues) / 60000)}分</b>。再生しながら先読みするので、待たずに観られます。`);
  p(`初回の読み込み：${fmtSec(r.warmMs)}`);
  refreshDiag();
};
$("reopen").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });

async function refreshAll() { await renderModels(); await refreshDiag(); }
load().then(refreshAll);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "sync" && (ch.model || ch.browserModel)) { Object.assign(S, Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, v.newValue]))); renderModels(); }
});
