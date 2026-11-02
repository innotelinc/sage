#!/usr/bin/env python3
"""Whisper speech-to-text on CPU, behind a tiny OpenAI-compatible API.

    POST /v1/audio/transcriptions   multipart: file, model, language -> {"text": ...}
    GET  /v1/models                 the model this service is actually running
    GET  /health                    {"ok": true, "ready": bool, ...}

faster-whisper (CTranslate2) rather than the torch build: int8 on CPU, no CUDA,
and a small model that runs faster than realtime on two cores. The service is
deliberately stupid — it transcribes and returns text; chunking, retries and
policy live in the Node app, exactly like the Kokoro sidecar next door.

Why a sidecar at all: a gateway key can be minted with a connection allowlist
that reaches no audio model, and then /audio/transcriptions answers 403 whatever
the app does. This gives SAGE an audio route it owns.
"""
import argparse
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_NAME = os.environ.get('STT_MODEL_NAME', 'Systran/faster-whisper-base.en')
MODEL_DIR = os.environ.get('STT_MODEL_DIR', os.path.join(HERE, 'models'))
THREADS = int(os.environ.get('STT_THREADS', '2'))
MAX_UPLOAD = 24 * 1024 * 1024

_lock = threading.Lock()      # CTranslate2 transcribes one at a time here
_model = None
_loaded_at = 0.0


def model():
    """Load once, on first use, and keep it resident."""
    global _model, _loaded_at
    if _model is None:
        from faster_whisper import WhisperModel

        started = time.time()
        _model = WhisperModel(
            MODEL_NAME,
            device='cpu',
            compute_type=os.environ.get('STT_COMPUTE_TYPE', 'int8'),
            cpu_threads=THREADS,
            download_root=MODEL_DIR,
            num_workers=1,
        )
        _loaded_at = time.time() - started
    return _model


def parse_multipart(body, content_type):
    """Minimal multipart/form-data split: enough for one audio part and a few fields."""
    match = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type or '')
    if not match:
        raise ValueError('no multipart boundary')
    boundary = (match.group(1) or match.group(2)).strip().encode()
    fields, files = {}, {}
    for part in body.split(b'--' + boundary):
        part = part.lstrip(b'\r\n')
        if not part or part.startswith(b'--'):
            continue
        head, sep, data = part.partition(b'\r\n\r\n')
        if not sep:
            continue
        if data.endswith(b'\r\n'):
            data = data[:-2]
        headers = head.decode('utf-8', 'replace')
        name = re.search(r'name="([^"]+)"', headers)
        if not name:
            continue
        filename = re.search(r'filename="([^"]*)"', headers)
        if filename is not None:
            files[name.group(1)] = (filename.group(1), data)
        else:
            fields[name.group(1)] = data.decode('utf-8', 'replace').strip()
    return fields, files


def transcribe(path, language=None):
    segments, info = model().transcribe(
        path,
        language=language or None,
        beam_size=1,                     # greedy: the latency win on CPU
        vad_filter=True,                 # skip silence instead of hallucinating it
        condition_on_previous_text=False,  # chunks are independent
        word_timestamps=False,
    )
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    return {
        'text': text,
        'language': getattr(info, 'language', language or ''),
        'duration': round(float(getattr(info, 'duration', 0.0)), 2),
        'model': MODEL_NAME,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = 'sage-stt/1.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _send(self, status, body, ctype='application/json; charset=utf-8'):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            body = {
                'ok': True,
                'ready': _model is not None,
                'model': MODEL_NAME,
                'threads': THREADS,
                'loadedIn': round(_loaded_at, 1),
            }
            return self._send(200, json.dumps(body))
        if self.path.startswith('/v1/models'):
            body = {'object': 'list', 'data': [{'id': MODEL_NAME, 'object': 'model', 'owned_by': 'sage'}]}
            return self._send(200, json.dumps(body))
        return self._send(404, '{"error":"not_found"}')

    def do_POST(self):
        if not self.path.startswith('/v1/audio/transcriptions'):
            return self._send(404, '{"error":"not_found"}')

        length = int(self.headers.get('content-length') or 0)
        if length <= 0 or length > MAX_UPLOAD:
            return self._send(400, '{"error":"bad_body"}')
        body = self.rfile.read(length)

        try:
            fields, files = parse_multipart(body, self.headers.get('content-type'))
        except Exception as exc:
            return self._send(400, json.dumps({'error': 'bad_form', 'message': str(exc)}))

        audio = files.get('file') or files.get('audio')
        if not audio or not audio[1]:
            return self._send(400, '{"error":"no_audio"}')

        filename, data = audio
        suffix = os.path.splitext(filename or '')[1] or '.webm'
        language = (fields.get('language') or '').split('-')[0] or None

        started = time.time()
        path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
                handle.write(data)
                path = handle.name
            with _lock:  # one transcription at a time: the model is not thread-safe
                result = transcribe(path, language)
            result['elapsed'] = round(time.time() - started, 2)
            return self._send(200, json.dumps(result))
        except Exception as exc:  # keep serving; one bad clip must not kill the unit
            message = str(exc)[:300]
            sys.stderr.write('transcribe failed: %s\n' % message)
            return self._send(500, json.dumps({'error': 'transcribe_failed', 'message': message}))
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


def main():
    parser = argparse.ArgumentParser(description='Whisper speech-to-text service (CPU)')
    parser.add_argument('--host', default=os.environ.get('STT_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('STT_PORT', '8881')))
    parser.add_argument('--no-warm', action='store_true', help='skip loading the model at boot')
    args = parser.parse_args()

    if not args.no_warm:
        print(f'loading {MODEL_NAME} ({THREADS} threads, int8)…', flush=True)
        model()
        print(f'loaded in {_loaded_at:.1f}s', flush=True)
    print(f'ready on http://{args.host}:{args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
