const send = (m) => chrome.runtime.sendMessage(m);
const $ = (id) => document.getElementById(id);
const { CATALOG, ModelStore } = PlamoStore;
const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : Math.round(n / 1e6) + " MB");
const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();

// Download a model through the background worker; resolves when finished.
function pullModel(model, onProgress) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "pull" });
    const t0 = Date.now();
    port.onMessage.addListener((m) => {
      if (m.error) { reject(new Error(m.error)); port.disconnect(); }
      else if (m.done) { resolve(); port.disconnect(); }
      else onProgress && onProgress(m, (Date.now() - t0) / 1000);
    });
    port.onDisconnect.addListener(() => reject(new Error("接続が切れました")));
    port.postMessage({ model });
  });
}

function bindProgress(barWrap, statEl) {
  const bar = barWrap.firstElementChild;
  return (m, secs) => {
    barWrap.style.display = "block";
    if (m.total && m.completed != null) {
      const pct = (m.completed / m.total) * 100;
      bar.style.width = pct.toFixed(1) + "%";
      const rate = m.completed / Math.max(secs, 0.5);
      statEl.textContent = `${m.status} ${pct.toFixed(0)}%  (${fmtBytes(m.completed)} / ${fmtBytes(m.total)}, ${(rate / 1e6).toFixed(1)} MB/s)`;
    } else statEl.textContent = m.status || "";
  };
}

// Download a browser-engine model into OPFS with a progress bar.
function downloadBrowserModel(key, barWrap, statEl) {
  const bar = barWrap.firstElementChild;
  barWrap.style.display = "block";
  return ModelStore.download(key, (p) => {
    const pct = (p.completed / p.total) * 100;
    bar.style.width = pct.toFixed(1) + "%";
    statEl.textContent = `ダウンロード中 ${pct.toFixed(0)}%  (${fmtBytes(p.completed)} / ${fmtBytes(p.total)}, ${(p.bytesPerSec / 1e6).toFixed(1)} MB/s)`;
  }).then(() => { statEl.textContent = "検証OK"; });
}
const modelUsable = (m) => ((m || {}).browser);
