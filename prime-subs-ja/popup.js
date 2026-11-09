const ids = ["enabled", "showEn", "showJa", "autoPause", "hoverPause", "hideNative"];
const el = (i) => document.getElementById(i);
const send = (m) => chrome.runtime.sendMessage(m);
const { CATALOG, ModelStore } = PlamoStore;
let loadingSince = 0;

chrome.storage.sync.get(null).then((s) => { for (const i of ids) el(i).checked = !!s[i]; });
for (const i of ids) el(i).addEventListener("change", () => chrome.storage.sync.set({ [i]: el(i).checked }));

function show(kind, title, detail, btn) {
  el("dot").className = "dot " + kind;
  el("engTitle").textContent = title;
  el("engDetail").textContent = detail || "";
  const b = el("engBtn");
  b.hidden = !btn;
  if (btn) { b.textContent = btn.label; b.className = btn.primary ? "pri" : "act"; b.onclick = btn.run; b.disabled = !!btn.disabled; }
}

async function refresh() {
  const s = await chrome.storage.sync.get(null);
  const model = CATALOG.find((m) => m.key === s.browserModel) || CATALOG[0];
  if (s.engine === "ollama") {
    const v = await send({ type: "version" });
    if (!v.ok) return show("bad", "Ollama に接続できません", "Ollama を起動するか、設定で「ブラウザ内」に切り替えてください。", { label: "設定", run: () => chrome.runtime.openOptionsPage() });
    const p = await send({ type: "ps" });
    const on = p.ok && p.models.some((m) => m.name.toLowerCase() === (s.model || "").toLowerCase());
    return on
      ? show("ok", "読み込み済み", "Ollama v" + v.version + " ・ " + s.model, { label: "外す", run: async () => { await send({ type: "unload" }); refresh(); } })
      : show("", "未読み込み", "Ollama v" + v.version + " につながっています。", { label: "読み込む", primary: true, run: load });
  }
  const installed = await ModelStore.installed();
  if (!installed.includes(model.key)) {
    return show("bad", "モデルが未取得です", model.name + "（" + Math.round(model.size / 1e6) + "MB）を取得すると使えます。", { label: "取得する", primary: true, run: () => chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }) });
  }
  const r = await send({ type: "engineStatus" });
  if (!r.ok) return show("bad", "エンジンを起動できません", r.error, { label: "再試行", run: refresh });
  const st = r.state;
  if (st.loading || loadingSince) {
    if (st.loaded) loadingSince = 0;
    else if (st.error) loadingSince = 0;
    else return show("busy", "読み込み中… " + Math.max(1, Math.round((Date.now() - loadingSince) / 1000)) + "秒", model.name + " を準備しています。", { label: "読み込み中", disabled: true });
  }
  if (st.loaded) {
    const tps = st.tokPerSec ? " ・ " + Math.round(st.tokPerSec) + " トークン/秒" : "";
    return show("ok", "読み込み済み", st.backend + " ・ " + model.name + " ・ スレッド " + st.threads + tps, { label: "外す", run: async () => { await send({ type: "unload" }); refresh(); } });
  }
  if (st.error) return show("bad", "読み込めませんでした", st.error, { label: "もう一度", primary: true, run: load });
  show("", "まだ読み込んでいません", model.name + " は取得済みです。字幕を訳す前に読み込んでおけます。", { label: "読み込む", primary: true, run: load });
}

async function load() {
  loadingSince = Date.now();
  show("busy", "読み込み中… 1秒", "", { label: "読み込み中", disabled: true });
  const r = await send({ type: "warm" });
  loadingSince = 0;
  if (!r.ok) show("bad", "読み込めませんでした", r.error, { label: "もう一度", primary: true, run: load });
  else refresh();
}

el("test").onclick = async () => {
  el("st").textContent = "訳しています…";
  const r = await send({ type: "ping" });
  el("st").textContent = r.ok ? "“Hello, how are you?” → " + r.ja : "うまくいきませんでした: " + r.error;
  refresh();
};
el("opt").onclick = () => chrome.runtime.openOptionsPage();
refresh();
setInterval(refresh, 1500);
