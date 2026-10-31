#!/usr/bin/env python3
"""Kokoro-82M speech on CPU, behind a tiny HTTP API.

    POST /synthesize  {"text": "...", "voice": "af_heart", "speed": 1.0}  -> audio/wav
    GET  /voices      -> {"voices": [...]}
    GET  /health      -> {"ok": true, ...}

kokoro-onnx rather than the torch build on purpose: no CUDA, no multi-gigabyte
wheel, and the quantised model still runs faster than realtime on a laptop CPU.
The service is deliberately stupid — it synthesizes and returns bytes; caching
and policy live in the Node app.
"""
import argparse
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get('KOKORO_MODEL', os.path.join(HERE, 'kokoro-v1.0.onnx'))
VOICEBANK = os.environ.get('KOKORO_VOICES', os.path.join(HERE, 'voices-v1.0.bin'))
DEFAULT_VOICE = os.environ.get('KOKORO_VOICE', 'af_heart')
VOICE_LIST = os.environ.get(
    'KOKORO_VOICE_LIST',
    'af_heart,af_bella,af_nicole,af_sarah,af_sky,am_michael,am_adam,bf_emma,bm_george',
)

_lock = threading.Lock()
_pipeline = None


def pipeline():
    """Load once, on first use, then reuse for every request."""
    global _pipeline
    if _pipeline is None:
        if not os.path.exists(MODEL):
            raise RuntimeError(f'model missing at {MODEL} — run fetch-model.sh')
        _pipeline = Kokoro(MODEL, VOICEBANK)
    return _pipeline


class Handler(BaseHTTPRequestHandler):
    server_version = 'sage-kokoro/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            ready = _pipeline is not None
            body = json.dumps({'ok': True, 'ready': ready, 'model': os.path.basename(MODEL), 'voice': DEFAULT_VOICE})
            self._send(200, body.encode(), 'application/json; charset=utf-8')
            return
        if self.path.startswith('/voices'):
            voices = [v.strip() for v in VOICE_LIST.split(',') if v.strip()]
            self._send(200, json.dumps({'voices': voices, 'default': DEFAULT_VOICE}).encode(), 'application/json; charset=utf-8')
            return
        self._send(404, b'{"error":"not_found"}', 'application/json')

    def do_POST(self):
        if not self.path.startswith('/synthesize'):
            self._send(404, b'{"error":"not_found"}', 'application/json')
            return

        length = int(self.headers.get('content-length') or 0)
        if length <= 0 or length > 64_000:
            self._send(400, b'{"error":"bad_body"}', 'application/json')
            return
        try:
            payload = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            self._send(400, b'{"error":"bad_json"}', 'application/json')
            return

        text = str(payload.get('text') or '').strip()
        if not text:
            self._send(400, b'{"error":"empty_text"}', 'application/json')
            return

        voice = str(payload.get('voice') or DEFAULT_VOICE)
        try:
            speed = min(max(float(payload.get('speed') or 1.0), 0.6), 1.6)
        except (TypeError, ValueError):
            speed = 1.0

        try:
            with _lock:  # one synthesis at a time; the model is not thread-safe
                samples, rate = pipeline().create(text[:1500], voice=voice, speed=speed, lang='en-us')
            buf = io.BytesIO()
            sf.write(buf, samples, rate, format='WAV', subtype='PCM_16')
            self._send(200, buf.getvalue(), 'audio/wav')
        except Exception as exc:  # keep serving; a bad voice must not kill the process
            message = str(exc)[:300]
            self._send(500, json.dumps({'error': 'synth_failed', 'message': message}).encode(), 'application/json')


def main():
    parser = argparse.ArgumentParser(description='Kokoro speech service (CPU)')
    parser.add_argument('--host', default=os.environ.get('KOKORO_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('KOKORO_PORT', '8880')))
    args = parser.parse_args()

    print(f'loading Kokoro: {MODEL}', flush=True)
    pipeline()
    print(f'ready on http://{args.host}:{args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
