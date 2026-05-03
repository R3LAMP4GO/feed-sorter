// Offscreen document — runs the @xenova/transformers MiniLM embedding model
// in a DOM-capable context (service workers can't host the WASM/ONNX runtime
// reliably). The model is loaded lazily on the first `embed` request and kept
// in memory for the life of the document.
//
// Protocol:
//   ← { type: "fs-offscreen", cmd: "embed", id, texts: string[] }
//   → { type: "fs-offscreen-resp", id, ok: true, vectors: number[][] }
//   → { type: "fs-offscreen-resp", id, ok: false, err }
//
// Background spawns this doc (chrome.offscreen.createDocument) when clustering
// is requested and tears it down with closeDocument() when finished.

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const TAG = "[fs-offscreen]";
const log = (...a) => console.log(TAG, ...a);

let pipelinePromise = null;

const loadPipeline = async () => {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    log("loading transformers.js");
    const url = chrome.runtime.getURL("vendor/transformers/transformers.min.js");
    const mod = await import(/* webpackIgnore: true */ url);
    const { pipeline, env } = mod;
    // Point ONNX at the wasm files we ship alongside the bundle. Without
    // this it falls back to a CDN which is blocked by the extension CSP.
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
    // Force single-threaded runtime — extension pages don't get the COOP/COEP
    // headers required for SharedArrayBuffer / threaded WASM.
    env.backends.onnx.wasm.numThreads = 1;
    // Models still come from the HuggingFace CDN; cached in browser storage.
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    log("model.load.start", MODEL_ID);
    const t0 = performance.now();
    const pipe = await pipeline("feature-extraction", MODEL_ID, { quantized: true });
    log("model.load.done", { ms: Math.round(performance.now() - t0) });
    return pipe;
  })().catch((e) => {
    log("model.load.fail", e);
    pipelinePromise = null;
    throw e;
  });
  return pipelinePromise;
};

// Mean-pool the [seqLen, dim] token embeddings into one [dim] vector.
const meanPoolToArray = (tensor) => {
  // transformers.js Tensor: { data: Float32Array, dims: [b, seq, dim] } when
  // pooling is disabled. With { pooling: "mean", normalize: true } we get
  // [b, dim] directly.
  const [b, dim] = tensor.dims;
  const out = [];
  for (let i = 0; i < b; i++) {
    out.push(Array.from(tensor.data.slice(i * dim, (i + 1) * dim)));
  }
  return out;
};

const embed = async (texts) => {
  const pipe = await loadPipeline();
  // Truncate each text aggressively (MiniLM accepts 256 tokens; ~1500 chars).
  const inputs = texts.map((t) => String(t || "").slice(0, 1500) || " ");
  const t0 = performance.now();
  const tensor = await pipe(inputs, { pooling: "mean", normalize: true });
  const vectors = meanPoolToArray(tensor);
  log("embed.done", { n: inputs.length, dim: vectors[0]?.length || 0, ms: Math.round(performance.now() - t0) });
  return vectors;
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "fs-offscreen") return;
  if (msg.cmd === "ping") { sendResponse({ ok: true }); return; }
  if (msg.cmd === "embed") {
    (async () => {
      try {
        const vectors = await embed(Array.isArray(msg.texts) ? msg.texts : []);
        sendResponse({ ok: true, vectors });
      } catch (e) {
        sendResponse({ ok: false, err: String(e?.message || e) });
      }
    })();
    return true; // async response
  }
});

log("ready");
