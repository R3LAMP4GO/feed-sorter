#!/usr/bin/env python3
"""Local sidecar that transcribes uploaded mp4 reels with faster-whisper.

Endpoints
---------
POST /transcribe
    multipart/form-data field `file` (mp4/mov/m4a/webm/wav).
    Optional form fields: `language` (ISO code, default auto-detect),
    `model` (overrides server default for this request).
    → 200 application/json
        {
          "text": "...",
          "language": "en",
          "language_probability": 0.97,
          "duration": 28.4,
          "segments": [{"start": 0.0, "end": 2.7, "text": " Hi there"}, ...],
          "model": "small",
          "elapsed_ms": 4831
        }

GET /health
    → {"ok": true, "model": "small", "device": "cpu",
       "loaded": true|false, "version": "1"}

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

MODEL_NAME = os.environ.get("FS_WHISPER_MODEL", "small")
DEVICE = os.environ.get("FS_WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("FS_WHISPER_COMPUTE_TYPE", "int8")
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
    """Return a process-wide WhisperModel, loading on first use."""
    global _model, _model_load_error
    target = name or MODEL_NAME
    with _model_lock:
        if _model is not None and getattr(_model, "_fs_name", None) == target:
            return _model
        try:
            from faster_whisper import WhisperModel  # heavy import
        except Exception as exc:  # pragma: no cover — import errors surface to caller
            _model_load_error = f"faster-whisper import failed: {exc}"
            log.error(_model_load_error)
            raise
        log.info("loading whisper model name=%s device=%s compute=%s",
                 target, DEVICE, COMPUTE_TYPE)
        t0 = time.time()
        m = WhisperModel(target, device=DEVICE, compute_type=COMPUTE_TYPE)
        m._fs_name = target  # type: ignore[attr-defined]
        _model = m
        _model_load_error = None
        log.info("model loaded in %.1fs", time.time() - t0)
        return _model


# Permissive CORS so a browser extension running on instagram.com can POST.
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
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "loaded": _model is not None,
        "load_error": _model_load_error,
        "max_upload_mb": MAX_UPLOAD_MB,
        "version": "1",
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

    # Persist to a tempfile — faster-whisper / ctranslate2 wants a real path
    # so ffmpeg can demux the mp4 container.
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        f.save(tmp.name)
        tmp.close()
        size = os.path.getsize(tmp.name)
        log.info("transcribe start file=%s bytes=%d lang=%s model=%s",
                 f.filename, size, language or "auto", model_name or MODEL_NAME)
        try:
            model = _get_model(model_name)
        except Exception as exc:
            return jsonify({"ok": False, "err": f"model load failed: {exc}"}), 500

        t0 = time.time()
        try:
            segments_iter, info = model.transcribe(
                tmp.name,
                language=language,
                beam_size=5,
                vad_filter=True,
            )
            segments = []
            chunks = []
            for seg in segments_iter:
                text = (seg.text or "").strip()
                segments.append({
                    "start": round(float(seg.start or 0.0), 3),
                    "end": round(float(seg.end or 0.0), 3),
                    "text": text,
                })
                if text:
                    chunks.append(text)
        except Exception as exc:
            log.exception("transcribe failed")
            return jsonify({"ok": False, "err": f"transcribe failed: {exc}"}), 500

        elapsed_ms = int((time.time() - t0) * 1000)
        out = {
            "ok": True,
            "text": " ".join(chunks).strip(),
            "language": getattr(info, "language", None),
            "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
            "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
            "segments": segments,
            "model": model_name or MODEL_NAME,
            "elapsed_ms": elapsed_ms,
        }
        log.info("transcribe done segs=%d chars=%d elapsed_ms=%d lang=%s",
                 len(segments), len(out["text"]), elapsed_ms, out["language"])
        return jsonify(out)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


if __name__ == "__main__":
    log.info("feed-sorter transcribe sidecar listening on http://%s:%d (model=%s)",
             HOST, PORT, MODEL_NAME)
    # threaded=True so concurrent uploads from the extension don't block
    # each other on the Flask side; the model itself is single-threaded so
    # the extension caps to concurrency=2.
    try:
        app.run(host=HOST, port=PORT, threaded=True)
    except KeyboardInterrupt:
        sys.exit(0)
