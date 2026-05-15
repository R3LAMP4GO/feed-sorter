#!/usr/bin/env python3
"""Local sidecar that transcribes uploaded mp4 reels with WhisperX.

WhisperX wraps faster-whisper and adds forced-alignment for word-level
timestamps. Pattern mirrors `mudler/LocalAI` `backend/python/whisperx/backend.py`
and `saaak/SubtitlePipeline` `backend/app/asr/cache.py`.

Endpoints
---------
POST /transcribe
    multipart/form-data field `file` (mp4/mov/m4a/webm/wav).
    Optional form fields:
      `language` (ISO code, default auto-detect)
      `model`   (overrides server default for this request)
      `align`   ('1' | '0', default '1' — run word-level alignment)
    → 200 application/json
        {
          "ok": true,
          "text": "...",
          "language": "en",
          "duration": 28.4,
          "segments": [
            { "start": 0.0, "end": 2.7, "text": " Hi there",
              "words": [{"word":"Hi","start":0.0,"end":0.4,"score":0.92}, ...]
            },
            ...
          ],
          "model": "small",
          "engine": "whisperx",
          "elapsed_ms": 4831
        }

GET /health
    → {"ok": true, "model": "small", "device": "cpu",
       "engine": "whisperx", "loaded": true|false, "version": "2"}

Run
---
    pip install -r requirements.txt
    python transcribe-server.py            # binds 127.0.0.1:8787
    FS_WHISPER_MODEL=base python transcribe-server.py
    FS_WHISPER_PORT=9000 python transcribe-server.py
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request

# Lazy import — keeps `--help` snappy and lets /health respond before the
# (large) model is downloaded on first call.
_model = None
_model_lock = threading.Lock()
_model_load_error: str | None = None
_align_cache: dict[str, tuple[object, object]] = {}
_align_lock = threading.Lock()

MODEL_NAME = os.environ.get("FS_WHISPER_MODEL", "small")
DEVICE = os.environ.get("FS_WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("FS_WHISPER_COMPUTE_TYPE",
                              "int8" if os.environ.get("FS_WHISPER_DEVICE", "cpu") == "cpu" else "float16")
BATCH_SIZE = int(os.environ.get("FS_WHISPER_BATCH_SIZE", "16"))
PORT = int(os.environ.get("FS_WHISPER_PORT", "8787"))
HOST = os.environ.get("FS_WHISPER_HOST", "127.0.0.1")
# Allow up to ~200 MB uploads (a 60s reel is well under this).
MAX_UPLOAD_MB = int(os.environ.get("FS_WHISPER_MAX_UPLOAD_MB", "200"))
ALLOWED_EXTS = {".mp4", ".mov", ".m4a", ".webm", ".wav", ".mp3", ".ogg", ".flac"}

log = logging.getLogger("fs-transcribe")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024


def _get_model(name: str | None = None):
    """Return a process-wide WhisperX model, loading on first use."""
    global _model, _model_load_error
    target = name or MODEL_NAME
    with _model_lock:
        if _model is not None and getattr(_model, "_fs_name", None) == target:
            return _model
        try:
            import whisperx  # heavy import
        except Exception as exc:  # pragma: no cover
            _model_load_error = f"whisperx import failed: {exc}"
            log.error(_model_load_error)
            raise
        log.info("loading whisperx model name=%s device=%s compute=%s",
                 target, DEVICE, COMPUTE_TYPE)
        t0 = time.time()
        m = whisperx.load_model(target, DEVICE, compute_type=COMPUTE_TYPE)
        m._fs_name = target  # type: ignore[attr-defined]
        _model = m
        _model_load_error = None
        log.info("whisperx model loaded in %.1fs", time.time() - t0)
        return _model


def _get_align_model(language_code: str):
    """Cache alignment models per language. Each language has its own model."""
    with _align_lock:
        cached = _align_cache.get(language_code)
        if cached is not None:
            return cached
        import whisperx
        log.info("loading alignment model lang=%s", language_code)
        t0 = time.time()
        align_model, metadata = whisperx.load_align_model(
            language_code=language_code, device=DEVICE,
        )
        log.info("alignment model loaded lang=%s in %.1fs", language_code, time.time() - t0)
        _align_cache[language_code] = (align_model, metadata)
        return _align_cache[language_code]


# Permissive CORS so the extension and our backend can POST.
@app.after_request
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/transcribe", methods=["OPTIONS"])
def _transcribe_preflight():
    return ("", 204)


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "engine": "whisperx",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "batch_size": BATCH_SIZE,
        "loaded": _model is not None,
        "load_error": _model_load_error,
        "max_upload_mb": MAX_UPLOAD_MB,
        "version": "2",
    })


@app.post("/transcribe")
def transcribe():
    if "file" not in request.files:
        return jsonify({"ok": False, "err": "missing 'file' multipart field"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "err": "empty filename"}), 400
    ext = Path(f.filename).suffix.lower() or ".mp4"
    if ext not in ALLOWED_EXTS:
        return jsonify({"ok": False, "err": f"unsupported extension {ext}"}), 415

    language = (request.form.get("language") or "").strip() or None
    model_name = (request.form.get("model") or "").strip() or None
    do_align = (request.form.get("align") or "1").strip() not in ("0", "false", "no")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        f.save(tmp.name)
        tmp.close()
        size = os.path.getsize(tmp.name)
        log.info("transcribe start file=%s bytes=%d lang=%s model=%s align=%s",
                 f.filename, size, language or "auto", model_name or MODEL_NAME, do_align)
        try:
            import whisperx
            model = _get_model(model_name)
        except Exception as exc:
            return jsonify({"ok": False, "err": f"model load failed: {exc}"}), 500

        t0 = time.time()
        try:
            audio = whisperx.load_audio(tmp.name)
            kwargs = {"batch_size": BATCH_SIZE}
            if language:
                kwargs["language"] = language
            result = model.transcribe(audio, **kwargs)
            detected_lang = result.get("language") or language or "en"
            segments = result.get("segments", []) or []

            # Word-level alignment — the WhisperX value-add over plain
            # faster-whisper. Falls back gracefully if no align model exists
            # for the detected language.
            if do_align and segments:
                try:
                    align_model, metadata = _get_align_model(detected_lang)
                    aligned = whisperx.align(
                        segments, align_model, metadata, audio, DEVICE,
                        return_char_alignments=False,
                    )
                    segments = aligned.get("segments", segments) or segments
                except Exception as exc:  # alignment is best-effort
                    log.warning("alignment failed lang=%s: %s", detected_lang, exc)

            out_segments = []
            chunks = []
            for seg in segments:
                text = (seg.get("text") or "").strip()
                row = {
                    "start": round(float(seg.get("start") or 0.0), 3),
                    "end": round(float(seg.get("end") or 0.0), 3),
                    "text": text,
                }
                words = seg.get("words")
                if isinstance(words, list) and words:
                    row["words"] = [
                        {
                            "word": (w.get("word") or "").strip(),
                            "start": round(float(w.get("start") or 0.0), 3) if w.get("start") is not None else None,
                            "end": round(float(w.get("end") or 0.0), 3) if w.get("end") is not None else None,
                            "score": round(float(w.get("score") or 0.0), 4) if w.get("score") is not None else None,
                        }
                        for w in words
                    ]
                out_segments.append(row)
                if text:
                    chunks.append(text)

            duration = float(out_segments[-1]["end"]) if out_segments else 0.0
            elapsed_ms = int((time.time() - t0) * 1000)
            out = {
                "ok": True,
                "engine": "whisperx",
                "text": " ".join(chunks).strip(),
                "language": detected_lang,
                "duration": round(duration, 3),
                "segments": out_segments,
                "model": model_name or MODEL_NAME,
                "elapsed_ms": elapsed_ms,
                "aligned": do_align,
            }
            log.info("transcribe done segs=%d chars=%d elapsed_ms=%d lang=%s aligned=%s",
                     len(out_segments), len(out["text"]), elapsed_ms, detected_lang, do_align)
            return jsonify(out)
        except Exception as exc:
            log.exception("transcribe failed")
            return jsonify({"ok": False, "err": f"transcribe failed: {exc}"}), 500
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


if __name__ == "__main__":
    log.info("feed-sorter whisperX sidecar listening on http://%s:%d (model=%s device=%s)",
             HOST, PORT, MODEL_NAME, DEVICE)
    try:
        app.run(host=HOST, port=PORT, threaded=True)
    except KeyboardInterrupt:
        sys.exit(0)
