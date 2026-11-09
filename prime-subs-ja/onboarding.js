async function envCheck() {
  const isolated = self.crossOriginIsolated;
  let gpu = "利用不可";
  try { const a = navigator.gpu && (await navigator.gpu.requestAdapter()); if (a) { const i = a.info || {}; gpu = "利用可（" + ([i.vendor, i.architecture].filter(Boolean).join(" ") || "WebGPU") + "）"; } } catch {}
  const est = await ModelStore.usage();
  $("envcard").className = "card" + (isolated ? " ok" : " bad");
  $("envmsg").textContent = (isolated ? "この PC で動かせます。" : "複数スレッドが使えない環境です。動作が遅くなります。") +
    ` GPU: ${gpu} ／ 論理コア ${navigator.hardwareConcurrency}` + (est && est.quota ? ` ／ 保存できる容量 約${fmtBytes(est.quota - (est.usage || 0))}` : "");
}
async function renderModels() {
  const S = await chrome.storage.sync.get(null);
  const installed = await ModelStore.installed();
  const box = $("models"); box.textContent = "";
  CATALOG.filter((m) => m.browser).forEach((m, idx) => {
    const have = installed.includes(m.key);
    const card = document.createElement("div"); card.className = "card" + (have ? " ok" : "");
    const top = document.createElement("div"); top.className = "row"; top.style.border = "none"; top.style.padding = "0";
    const l = document.createElement("div"); l.className = "l";
    const t = document.createElement("div"); t.append(m.name + "  ");
    const sz = document.createElement("span"); sz.className = "badge"; sz.textContent = fmtBytes(m.size); t.append(sz);
    if (idx === 0) { const b = document.createElement("span"); b.className = "badge use"; b.style.marginLeft = "6px"; b.textContent = "まずはこれ"; t.append(b); }
    const small = document.createElement("small"); small.textContent = m.note;
    l.append(t, small);
    const act = document.createElement("div");
    const bar = document.createElement("div"); bar.className = "bar"; bar.append(document.createElement("i"));
    const stat = document.createElement("div"); stat.className = "stat";
    const btn = document.createElement("button");
    if (have) {
      if (S.browserModel === m.key) { btn.textContent = "使用中"; btn.disabled = true; }
      else { btn.textContent = "こちらを使う"; btn.className = "act"; btn.onclick = async () => { await chrome.storage.sync.set({ browserModel: m.key }); send({ type: "unload" }).catch(() => {}); renderModels(); }; }
    } else {
      btn.textContent = "取得する"; btn.className = "pri";
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await downloadBrowserModel(m.key, bar, stat);
          if (!installed.length) await chrome.storage.sync.set({ browserModel: m.key, engine: "browser" });
          renderModels();
        } catch (e) { stat.textContent = "失敗: " + e.message; btn.disabled = false; }
      };
    }
    act.append(btn); top.append(l, act); card.append(top, bar, stat); box.append(card);
  });
}
$("test").onclick = async () => {
  $("testOut").textContent = "訳しています…";
  const r = await send({ type: "ping" });
  $("testOut").textContent = r.ok ? "“Hello, how are you?” → " + r.ja : "うまくいきませんでした: " + r.error;
};
$("useOllama").onclick = async () => {
  await chrome.storage.sync.set({ engine: "ollama" });
  const v = await send({ type: "version" });
  $("ollamaMsg").textContent = v.ok ? "Ollama v" + v.version + " につながりました。モデルは設定で選べます。" : "Ollama につながりません: " + v.error;
};
$("open").onclick = () => chrome.tabs.create({ url: "https://www.amazon.co.jp/gp/video/storefront" });
$("settings").onclick = () => chrome.runtime.openOptionsPage();
$("close").onclick = () => window.close();
envCheck(); renderModels();
