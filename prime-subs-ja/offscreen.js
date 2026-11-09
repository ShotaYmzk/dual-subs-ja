// Hosts the in-browser llama.cpp (wllama, WebGPU / CPU) inside an offscreen document.
// The service worker cannot spawn the pthread workers this needs.
import { Wllama } from "./vendor/wllama/wllama.js";

const { CATALOG, ModelStore } = globalThis.PlamoStore;
const STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];
const CONTEXT = 4096;
const WEBGPU_ALL_LAYERS = 99999;

let wllama = null;
let state = { loaded: false, key: null, backend: null, threads: 0, mode: null, gpu: null, tokPerSec: null, error: null, loading: false };
let loadPromise = null;
let queue = Promise.resolve();
let idleTimer = null;
let lastCfg = null;

const asset = (n) => chrome.runtime.getURL("vendor/wllama/" + n);

async function probeGpu() {
  try {
    if (!navigator.gpu) return { ok: false, reason: "navigator.gpu なし" };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false, reason: "アダプタなし" };
    const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
    return { ok: true, name: [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

// Same idea as llama.cpp's own log: only report "missing" on positive evidence.
function gpuEvidence(lines) {
  let tensors = false;
  for (const l of lines) {
    if (/using device WebGPU/i.test(l)) return "engaged";
    const m = /offloaded (\d+)\/\d+ layers to GPU/i.exec(l);
    if (m) return Number(m[1]) > 0 ? "engaged" : "missing";
    if (/ggml_webgpu: Failed to get (?:an adapter|a device)/i.test(l)) return "missing";
    if (/load_tensors:/.test(l)) tensors = true;
  }
  return tensors ? "missing" : "unknown";
}

function selection(mode, gpuOk) {
  const cores = Math.max(1, navigator.hardwareConcurrency || 4);
  const t = (n) => Math.max(1, Math.min(n, cores));
  const gpu = { backend: "WebGPU", nGpuLayers: WEBGPU_ALL_LAYERS, nThreads: t(8) };
  const c8 = { backend: "CPU", nGpuLayers: 0, nThreads: t(8) };
  const c4 = { backend: "CPU", nGpuLayers: 0, nThreads: t(4) };
  if (mode === "webgpu") return gpu;
  if (mode === "cpu8") return c8;
  if (mode === "cpu4") return c4;
  return gpuOk ? gpu : cores >= 8 ? c8 : c4; // auto
}

async function dispose() {
  const w = wllama;
  wllama = null;
  state = { ...state, loaded: false, backend: null };
  if (w) await w.exit().catch(() => {});
}

async function loadWith(sel, file) {
  const lines = [];
  const note = (...d) => { if (lines.length < 2000) lines.push(d.map(String).join(" ")); };
  const w = new Wllama(
    {
      default: asset("wllama.wasm"),
      "wllama.worker.js": asset("wllama-worker.js"),
      "wllama.module.js": asset("wllama-module.js"),
      "wllama.pthread.js": asset("wllama-pthread.js")
    },
    { suppressNativeLog: false, logger: { debug: note, log: note, warn: note, error: note } }
  );
  try {
    await w.loadModel([file], {
      n_ctx: CONTEXT,
      n_threads: sel.nThreads,
      n_gpu_layers: sel.nGpuLayers,
      n_parallel: 1,
      swa_full: true,
      ctx_shift: false,
      log_level: 2
    });
  } catch (e) {
    await w.exit().catch(() => {});
    throw e;
  }
  if (sel.backend === "WebGPU" && gpuEvidence(lines) === "missing") {
    await w.exit().catch(() => {});
    throw new Error("WebGPU を要求しましたが、モデルが GPU に載りませんでした");
  }
  return w;
}

async function ensureLoaded(cfg) {
  lastCfg = cfg;
  if (wllama && state.key === cfg.browserModel && state.mode === cfg.mode) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    await dispose();
    state = { ...state, loading: true, error: null };
    try {
      const installed = await ModelStore.installed();
      if (!installed.includes(cfg.browserModel)) throw new Error("モデルがダウンロードされていません。設定画面からダウンロードしてください。");
      const file = await ModelStore.getFile(cfg.browserModel);
      const gpu = await probeGpu();
      let sel = selection(cfg.mode, gpu.ok);
      let w;
      try { w = await loadWith(sel, file); }
      catch (e) {
        if (sel.backend === "WebGPU" && cfg.mode === "auto") {
          console.warn("WebGPU failed, falling back to CPU:", e);
          sel = selection("cpu8", false);
          w = await loadWith(sel, file);
        } else throw e;
      }
      wllama = w;
      state = { ...state, loaded: true, loading: false, key: cfg.browserModel, backend: sel.backend, threads: sel.nThreads, mode: cfg.mode, gpu: gpu.ok ? gpu.name : "利用不可: " + gpu.reason, error: null };
    } catch (e) {
      state = { ...state, loaded: false, loading: false, error: String(e.message || e) };
      throw e;
    } finally { loadPromise = null; }
  })();
  return loadPromise;
}

function armIdle(cfg) {
  clearTimeout(idleTimer);
  const ms = { "1m": 60e3, "5m": 300e3, "15m": 900e3 }[cfg.keepAlive];
  if (ms) idleTimer = setTimeout(() => dispose(), ms);
}

function complete(cfg, prompt, maxTokens) {
  const run = async () => {
    await ensureLoaded(cfg);
    const t0 = performance.now();
    const res = await wllama.createCompletion({
      prompt, max_tokens: maxTokens || 300, temperature: 0, cache_prompt: true, stop: STOP, stream: false
    });
    const ms = performance.now() - t0;
    const tokens = res.usage && res.usage.completion_tokens;
    const tps = res.timings && res.timings.predicted_per_second;
    if (tokens > 4) state.tokPerSec = tps || tokens / (ms / 1000);
    armIdle(cfg);
    return { text: res.choices[0].text, tokens, ms };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  const done = (p) => p.then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg.op) {
    case "complete": done(complete(msg.cfg, msg.prompt, msg.maxTokens)); return true;
    case "status": done(probeGpu().then((g) => ({ state: { ...state }, gpuProbe: g, cores: navigator.hardwareConcurrency, isolated: self.crossOriginIsolated }))); return true;
    case "unload": done(dispose().then(() => ({}))); return true;
    case "warm": done(ensureLoaded(msg.cfg).then(() => ({ state: { ...state } }))); return true;
  }
});
