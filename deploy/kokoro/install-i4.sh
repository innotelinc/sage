#!/usr/bin/env bash
# Install the Kokoro speech sidecar inside the SAGE container on i4 and point the
# app at it. Run from the host holding the incus TLS remote; expects the repo's
# deploy/kokoro files staged in /root/kokoro/.
set -uo pipefail

R=i4move:
NAME=sage
log() { echo "[$(date +%H:%M:%S)] $*"; }
bx() { timeout 180 incus exec "$R$NAME" -- "$@" 2>/dev/null; }

log "1. python tooling"
bx bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq'
bx bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq python3 python3-venv python3-pip curl'
bx bash -c 'python3 -m venv /opt/kokoro/venv'

log "2. python packages (onnxruntime, no torch)"
bx bash -c '/opt/kokoro/venv/bin/pip install --quiet --upgrade pip'
bx bash -c '/opt/kokoro/venv/bin/pip install --quiet kokoro-onnx soundfile numpy'
bx bash -c '/opt/kokoro/venv/bin/python -c "import kokoro_onnx, soundfile; print(\"imports ok\")"'

log "3. model files (~340 MB)"
bx bash -c 'cd /opt/kokoro && [ -s kokoro-v1.0.onnx ] || curl -fL --retry 3 -o kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'
bx bash -c 'cd /opt/kokoro && [ -s voices-v1.0.bin ] || curl -fL --retry 3 -o voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'
bx bash -c 'ls -lh /opt/kokoro/*.onnx /opt/kokoro/*.bin'

log "4. service + unit"
incus exec "$R$NAME" -- bash -c 'cat > /opt/kokoro/service.py' < /root/kokoro/service.py
incus exec "$R$NAME" -- bash -c 'cat > /etc/systemd/system/sage-kokoro.service' < /root/kokoro/sage-kokoro.service
bx bash -c 'systemctl daemon-reload; systemctl enable sage-kokoro; systemctl restart sage-kokoro'

log "5. wait for the voice"
for _ in $(seq 1 30); do
  if bx bash -c 'curl -fsS --max-time 3 http://127.0.0.1:8880/health >/dev/null'; then break; fi
  sleep 5
done
bx bash -c 'curl -s --max-time 5 http://127.0.0.1:8880/health'; echo
bx bash -c 'systemctl is-active sage-kokoro'

log "6. synthesize a sample"
bx bash -c 'curl -s --max-time 60 -X POST http://127.0.0.1:8880/synthesize -H "content-type: application/json" -d "{\"text\":\"Study mode is listening. Ask when you are ready.\",\"voice\":\"af_heart\"}" -o /tmp/sample.wav -w "http=%{http_code} bytes=%{size_download}\n"'
bx bash -c 'ls -l /tmp/sample.wav; head -c 4 /tmp/sample.wav | od -c | head -1'

log "7. point SAGE at it"
bx bash -c 'grep -q "^TTS_URL=" /opt/sage/.env && sed -i "s|^TTS_URL=.*|TTS_URL=http://127.0.0.1:8880|" /opt/sage/.env || echo "TTS_URL=http://127.0.0.1:8880" >> /opt/sage/.env'
bx bash -c 'grep -q "^TTS_VOICE=" /opt/sage/.env || echo "TTS_VOICE=af_heart" >> /opt/sage/.env'
bx bash -c 'systemctl restart sage'
sleep 4

log "8. app-side check"
bx bash -c 'curl -s --max-time 10 http://127.0.0.1:443/api/tts/status'; echo
bx bash -c 'curl -s --max-time 60 -X POST http://127.0.0.1:443/api/tts -H "content-type: application/json" -d "{\"text\":\"The voice is now local and smooth.\"}" -o /tmp/app.wav -w "http=%{http_code} type=%{content_type} bytes=%{size_download}\n"'
bx bash -c 'head -c 4 /tmp/app.wav | od -c | head -1'
log DONE
