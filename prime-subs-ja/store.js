// Model catalog + browser-side model storage (OPFS) + verified download.
// Classic script: defines globals used by options / onboarding / offscreen pages.
(function (root) {
  // URLs are pinned to Hugging Face commits so the sha256 below stays valid.
  const CATALOG = [
    {
      key: "0.8b", name: "標準（0.8B）", note: "軽くて速い。ふつうのPCならこれで十分",
      file: "plamo-3-translate-0.8b-Q4_K_M.gguf", size: 573123200,
      sha256: "923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd",
      url: "https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf",
      ollama: "hf.co/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M", browser: true
    },
    {
      key: "2b", name: "高精度（2B）", note: "訳が安定。GPU / 8GB 以上のメモリ推奨",
      file: "plamo-3-translate-2b-Q4_K_M.gguf", size: 1807199392,
      sha256: "f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0",
      url: "https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf",
      ollama: "hf.co/pfnet/plamo-3-translate-2b-GGUF:Q4_K_M", browser: true
    },
    {
      key: "8b", name: "最高精度（8B）", note: "慣用句に強い。Ollama 専用（16GB 以上のメモリ推奨）",
      file: "plamo-3-translate-8b-Q4_K_M.gguf", size: 5280442080,
      sha256: "47a04e86a67bcc352fa186f01159060aae594b73993e1d49dbfc0ef0081d01ad",
      url: "https://huggingface.co/pfnet/plamo-3-translate-8b-GGUF/resolve/2234f168757f570714b333049c9d018161ec5277/plamo-3-translate-8b-Q4_K_M.gguf",
      ollama: "hf.co/pfnet/plamo-3-translate-8b-GGUF:Q4_K_M", browser: false
    }
  ];

  // ---- incremental SHA-256 (SubtleCrypto cannot hash a stream) ----
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  class Sha256 {
    constructor() {
      this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
      this.buf = new Uint8Array(64); this.n = 0; this.len = 0; this.w = new Uint32Array(64);
    }
    _block(b, o) {
      const w = this.w, h = this.h;
      for (let i = 0; i < 16; i++) { const j = o + i * 4; w[i] = (b[j] << 24) | (b[j+1] << 16) | (b[j+2] << 8) | b[j+3]; }
      for (let i = 16; i < 64; i++) {
        const a = w[i-15], c = w[i-2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      let a = h[0], b2 = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b2) ^ (a & c) ^ (b2 & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b2) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    update(data) {
      this.len += data.length;
      let i = 0;
      if (this.n) {
        const take = Math.min(64 - this.n, data.length);
        this.buf.set(data.subarray(0, take), this.n); this.n += take; i = take;
        if (this.n === 64) { this._block(this.buf, 0); this.n = 0; }
      }
      for (; i + 64 <= data.length; i += 64) this._block(data, i);
      if (i < data.length) { this.buf.set(data.subarray(i), 0); this.n = data.length - i; }
    }
    hex() {
      const bits = this.len * 8;
      const pad = new Uint8Array(((this.n < 56 ? 56 : 120) - this.n) + 8);
      pad[0] = 0x80;
      const dv = new DataView(pad.buffer);
      dv.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
      dv.setUint32(pad.length - 4, bits >>> 0);
      this.update(pad);
      return [...this.h].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
    }
  }

  // ---- OPFS store ----
  async function dir() {
    const r = await navigator.storage.getDirectory();
    return r.getDirectoryHandle("models", { create: true });
  }
  const find = (key) => CATALOG.find((m) => m.key === key);

  const ModelStore = {
    // Complete models only: a `.ok` marker is written after the hash check passes.
    async installed() {
      const d = await dir();
      const out = [];
      for (const m of CATALOG) {
        try {
          const okFile = await (await d.getFileHandle(m.file + ".ok")).getFile();
          const meta = JSON.parse(await okFile.text());
          const f = await (await d.getFileHandle(m.file)).getFile();
          if (meta.sha256 === m.sha256 && f.size === m.size) out.push(m.key);
        } catch {}
      }
      return out;
    },
    async getFile(key) {
      const m = find(key);
      const d = await dir();
      return (await d.getFileHandle(m.file)).getFile();
    },
    async remove(key) {
      const m = find(key), d = await dir();
      for (const n of [m.file, m.file + ".ok"]) await d.removeEntry(n).catch(() => {});
    },
    async usage() { try { const e = await navigator.storage.estimate(); return e; } catch { return null; } },
    // onProgress({phase:'download'|'verify', completed, total, bytesPerSec})
    async download(key, onProgress, signal) {
      const m = find(key), d = await dir();
      await this.remove(key);
      const fh = await d.getFileHandle(m.file, { create: true });
      const w = await fh.createWritable();
      const sha = new Sha256();
      const t0 = performance.now();
      let done = 0, attempt = 0;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        // The file is large, so a dropped connection must not mean starting over: resume with a Range request
        // from the byte where it stopped (the hash and the output file simply continue).
        while (done < m.size) {
          try {
            const res = await fetch(m.url, { signal, headers: done ? { Range: "bytes=" + done + "-" } : {} });
            if (!res.ok || !res.body) throw new Error("ダウンロードに失敗しました (HTTP " + res.status + ")");
            if (done && res.status !== 206) throw new Error("途中からの再開に対応していません (HTTP " + res.status + ")");
            const reader = res.body.getReader();
            for (;;) {
              const { done: end, value } = await reader.read();
              if (end) break;
              sha.update(value);           // hash as we go: no second pass over the file
              await w.write(value);
              done += value.length;
              attempt = 0;
              onProgress && onProgress({ phase: "download", completed: done, total: m.size, bytesPerSec: done / Math.max(0.5, (performance.now() - t0) / 1000) });
            }
          } catch (e) {
            if ((signal && signal.aborted) || ++attempt > 8) throw e;
            onProgress && onProgress({ phase: "retry", completed: done, total: m.size, bytesPerSec: 0 });
            await sleep(Math.min(8000, 800 * attempt));
          }
        }
        await w.close();
      } catch (e) {
        try { await w.abort(); } catch {}
        await this.remove(key);
        throw e;
      }
      if (done !== m.size || sha.hex() !== m.sha256) {
        await this.remove(key);
        throw new Error("ダウンロードしたファイルの検証に失敗しました（サイズまたはSHA-256が一致しません）");
      }
      const ok = await (await d.getFileHandle(m.file + ".ok", { create: true })).createWritable();
      await ok.write(JSON.stringify({ sha256: m.sha256, size: m.size }));
      await ok.close();
    }
  };

  const api = { CATALOG, ModelStore, Sha256 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PlamoStore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
