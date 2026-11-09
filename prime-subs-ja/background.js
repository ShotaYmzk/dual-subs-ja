const MODEL_REPO = (size) => `hf.co/pfnet/plamo-3-translate-${size}-GGUF:Q4_K_M`;
const DEFAULTS = {
  enabled: true,
  hideNative: true,
  showEn: true,
  showJa: true,
  autoPause: false,
  hoverPause: true,
  offset: 0,
  fontSize: 28,
  form: "plain", // "plain" | "polite" | ""
  engine: "browser", // "browser" (WebGPU / CPU, no install) | "ollama"
  mode: "auto", // browser engine: "auto" | "webgpu" | "cpu8" | "cpu4"
  browserModel: "0.8b", // "0.8b" | "2b"
  model: MODEL_REPO("0.8b"), // Ollama model tag
  endpoint: "http://localhost:11434",
  keepAlive: "5m" // "1m" | "5m" | "15m" | "-1" (never unload)
};

const STOP = ["<|plamo:tag|>", "<|plamo:bos|>"];

function tag(name, attrs, msg) {
  let s = "<|plamo:tag|>" + name;
  for (const [k, v] of attrs) s += `<|plamo:key|>${k}<|plamo:val|>${v}`;
  return s + "<|plamo:msg|>" + msg;
}

// PFML3 prompt (model card format). history = [[en, ja], ...], glossary = [[src, dst], ...]
function buildPrompt(text, history, form, context, glossary, to) {
  let p = tag("dataset", [], "translation");
  if (context) p += tag("context", [], context);
  const dst = [["lang", to || "ja"]];
  if (form && (to || "ja") === "ja") dst.push(["form", form]);
  for (const [en, ja] of history || []) p += tag("input", [], en) + tag("output", dst, ja);
  if (glossary && glossary.length) {
    p += tag("glossary", [], glossary.map(([s, t]) => `<|plamo:index|>${s}<|plamo:item|>${t}`).join(""));
  }
  return p + tag("input", [], text) + tag("output", dst, "");
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function getGlossary() {
  const { glossary = "" } = await chrome.storage.local.get("glossary");
  return glossary
    .split(/\r?\n/)
    .map((l) => { const i = l.indexOf(","); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; })
    .filter((x) => x && x[0] && x[1]);
}

const base = (s) => s.endpoint.replace(/\/$/, "");

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run the local translation model (llama.cpp WebAssembly / WebGPU) in worker threads"
  });
}

async function offscreen(op, extra) {
  await ensureOffscreen();
  // The offscreen page loads its module script asynchronously, so the first messages can
  // arrive before its listener exists ("Receiving end does not exist"). Retry briefly.
  let r, lastErr;
  for (let i = 0; i < 40; i++) {
    try {
      r = await chrome.runtime.sendMessage({ target: "offscreen", op, ...extra });
      if (r) break;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 150));
  }
  if (!r) throw new Error("ブラウザ内蔵エンジンを起動できません: " + ((lastErr && lastErr.message) || "応答なし"));
  if (!r.ok) throw new Error(r.error || "offscreen engine failed");
  return r;
}

const engineCfg = (s) => ({ browserModel: s.browserModel, mode: s.mode, keepAlive: s.keepAlive });

async function translate({ text, history, context, maxTokens, noGlossary, to }) {
  const s = await getSettings();
  let glossary = noGlossary ? [] : await getGlossary();
  if (to === "en") glossary = glossary.map(([en, ja]) => [ja, en]); // entries are written "English,日本語"
  const prompt = buildPrompt(text, history, s.form, context, glossary, to);
  if (s.engine === "browser") {
    const r = await offscreen("complete", { cfg: engineCfg(s), prompt, maxTokens: maxTokens || 300 });
    return { ja: (r.text || "").trim(), raw: { eval_count: r.tokens, eval_duration: r.ms * 1e6 } };
  }
  const res = await fetch(base(s) + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: s.model,
      raw: true,
      stream: false,
      keep_alive: s.keepAlive === "-1" ? -1 : s.keepAlive,
      prompt,
      options: { temperature: 0, num_predict: maxTokens || 300, stop: STOP }
    })
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { ja: (j.response || "").trim(), raw: j };
}

const wrap = (p, sendResponse, pick) =>
  p.then((r) => sendResponse({ ok: true, ...pick(r) }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));

// ---- Ollama management (all requests go through here so the Origin-stripping rule applies) ----
async function ollamaJSON(path, init) {
  const s = await getSettings();
  const res = await fetch(base(s) + path, init);
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function bench() {
  const t0 = Date.now();
  const { ja, raw } = await translate({
    text: "The quick brown fox jumps over the lazy dog, and then it runs back into the forest.",
    history: [], noGlossary: true
  });
  return { ja, tokPerSec: raw.eval_count && raw.eval_duration ? raw.eval_count / (raw.eval_duration / 1e9) : null, ms: Date.now() - t0 };
}

// Speed test: realistic subtitle lines of increasing length, English -> Japanese.
const BENCH_SAMPLES = [
  { label: "短いセリフ", text: "I'll take a rain check." },
  { label: "ふつうのセリフ", text: "Listen to me. If we leave now, we can still make it to the airport before they close the gate." },
  { label: "長めのセリフ", text: "The committee has decided to postpone the vote until further evidence is presented, which critics say is nothing more than a delay tactic designed to protect the people who stand to lose the most if the truth comes out." },
  { label: "長い独白", text: "When I was a kid, my father used to say that you never really know a person until you have seen them lose everything. I thought it was just one of his sayings, but standing here tonight, watching the rain wash the last of our plans down the street, I finally understand what he meant, and I wish I had listened to him a lot sooner." }
];

async function benchSuite() {
  const t0 = Date.now();
  await translate({ text: "Hello.", history: [], noGlossary: true, to: "ja" }); // warm-up: model load + shader compile
  const warmMs = Date.now() - t0;
  const rows = [];
  for (const smp of BENCH_SAMPLES) {
    const t = Date.now();
    const { ja, raw } = await translate({ text: smp.text, history: [], noGlossary: true, to: "ja" });
    const ms = Date.now() - t;
    const tokens = raw.eval_count || 0;
    rows.push({ label: smp.label, en: smp.text, ja, ms, tokens, tokPerSec: tokens && ms ? tokens / (ms / 1000) : null });
  }
  return { warmMs, rows };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case "translate":
      wrap(translate({ text: msg.text, history: msg.history, to: msg.to }), sendResponse, (r) => ({ ja: r.ja }));
      return true;
    case "word":
      wrap(translate({ text: msg.word, history: [], context: msg.sentence, maxTokens: 40, noGlossary: true }), sendResponse, (r) => ({ ja: r.ja }));
      return true;
    case "ping":
      wrap(translate({ text: "Hello, how are you?", history: [], noGlossary: true }), sendResponse, (r) => ({ ja: r.ja }));
      return true;
    case "version":
      wrap(ollamaJSON("/api/version"), sendResponse, (r) => ({ version: r.version }));
      return true;
    case "tags":
      wrap(ollamaJSON("/api/tags"), sendResponse, (r) => ({ models: r.models || [] }));
      return true;
    case "ps":
      wrap(ollamaJSON("/api/ps"), sendResponse, (r) => ({ models: r.models || [] }));
      return true;
    case "delete":
      wrap(
        getSettings().then((s) => fetch(base(s) + "/api/delete", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: msg.model })
        })).then((r) => { if (!r.ok) throw new Error("delete failed " + r.status); return {}; }),
        sendResponse, (r) => r);
      return true;
    case "unload":
      wrap(
        getSettings().then(async (st) => {
          if (st.engine === "browser") { await offscreen("unload"); return {}; }
          await fetch(base(st) + "/api/generate", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: st.model, keep_alive: 0 })
          });
          return {};
        }),
        sendResponse, (r) => r);
      return true;
    case "engineStatus":
      wrap(offscreen("status"), sendResponse, (r) => ({ state: r.state, gpuProbe: r.gpuProbe, cores: r.cores, isolated: r.isolated }));
      return true;
    case "warm":
      wrap(
        getSettings().then(async (st) => {
          if (st.engine === "browser") { const r = await offscreen("warm", { cfg: engineCfg(st) }); return { state: r.state }; }
          await translate({ text: "Hello.", history: [], noGlossary: true, to: "ja" }); // Ollama loads the model on first use
          return { state: { loaded: true, backend: "Ollama", key: st.model } };
        }),
        sendResponse, (r) => r);
      return true;
    case "benchSuite":
      wrap(benchSuite(), sendResponse, (r) => r);
      return true;
    case "bench":
      wrap(bench(), sendResponse, (r) => r);
      return true;
  }
});

// Streaming model download with progress (port stays open for the duration).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pull") return;
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());
  port.onMessage.addListener(async ({ model }) => {
    try {
      const s = await getSettings();
      const res = await fetch(base(s) + "/api/pull", {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true })
      });
      if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          port.postMessage({ status: j.status, total: j.total, completed: j.completed });
        }
      }
      port.postMessage({ done: true });
    } catch (e) {
      try { port.postMessage({ error: String(e.message || e) }); } catch {}
    }
  });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.sync.get(null);
  const next = { ...DEFAULTS, ...cur };
  if (!cur.v2) { next.hideNative = true; next.v2 = true; } // one-time: dual-subtitle UI hides native captions
  await chrome.storage.sync.set(next);
  if (details.reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
});

// Ollama rejects requests carrying a chrome-extension:// Origin (403), so strip the
// Origin header from this extension's own requests. Session rules are needed for tabIds;
// the initiatorDomains variants cover extension pages opened in a tab (options / onboarding).
async function installOriginRules() {
  const strip = { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] };
  const types = ["xmlhttprequest", "other"];
  const rules = [];
  let id = 1;
  for (const host of ["localhost", "127.0.0.1"]) {
    const f = `||${host}:11434/`;
    rules.push({ id: id++, priority: 1, action: strip, condition: { urlFilter: f, resourceTypes: types, tabIds: [-1] } });
    rules.push({ id: id++, priority: 1, action: strip, condition: { urlFilter: f, resourceTypes: types, initiatorDomains: [chrome.runtime.id] } });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1, 2, 3, 4], addRules: rules });
}
installOriginRules().catch((e) => console.error("DNR rules failed", e));
