#!/usr/bin/env bash
# Install the Whisper speech-to-text sidecar inside the SAGE container on i4 and
# point the app at it. Run from the host holding the incus TLS remote; expects
# the repo's deploy/stt files staged in /root/stt/.
#
#   STT_MODEL=Systran/faster-whisper-base.en bash install-i4.sh
#
# The model is chosen by argument/env so the same script can test a faster one.
set -uo pipefail

R=i4move:
NAME=sage
MODEL="${STT_MODEL:-Systran/faster-whisper-base.en}"
PORT="${STT_PORT:-8881}"
log() { echo "[$(date +%H:%M:%S)] $*"; }
bx() { timeout 300 incus exec "$R$NAME" -- "$@" 2>/dev/null; }
bxo() { timeout 300 incus exec "$R$NAME" -- "$@"; }

log "0. model = $MODEL on port $PORT"
bx bash -c 'mkdir -p /opt/stt/models'

log "1. python tooling"
bx bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null'
bx bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq python3-venv python3-pip curl >/dev/null'
bx bash -c '[ -x /opt/stt/venv/bin/python ] || python3 -m venv /opt/stt/venv'

log "2. faster-whisper (CTranslate2, no torch)"
bx bash -c '/opt/stt/venv/bin/pip install --quiet --upgrade pip'
# PyAV 19 dropped the metadata_errors kwarg faster-whisper 1.2.1 still passes,
# so the resolver alone installs a pair that cannot open a file. Pin it.
bxo bash -c '/opt/stt/venv/bin/pip install --quiet faster-whisper "av>=14,<19" 2>&1 | tail -3'
bx bash -c '/opt/stt/venv/bin/python -c "import faster_whisper, ctranslate2; print(\"faster-whisper\", faster_whisper.__version__, \"ct2\", ctranslate2.__version__)"'

log "3. create the systemd unit"
bxo bash -c "cat > /etc/systemd/system/sage-stt.service" <<'UNIT'
[Unit]
Description=Whisper speech-to-text for SAGE (CPU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/stt
Environment=STT_HOST=127.0.0.1
Environment=STT_PORT=8881
Environment=STT_THREADS=2
Environment=STT_COMPUTE_TYPE=int8
Environment=OMP_NUM_THREADS=2
Environment=STT_MODEL_NAME=MODEL_PLACEHOLDER
ExecStart=/opt/stt/venv/bin/python /opt/stt/service.py
Restart=always
RestartSec=5
MemoryMax=900M

[Install]
WantedBy=multi-user.target
UNIT
bx bash -c "sed -i 's|^Environment=STT_MODEL_NAME=.*|Environment=STT_MODEL_NAME=$MODEL|' /etc/systemd/system/sage-stt.service"

log "4. fetch the model weights now, so the first user does not wait"
bxo bash -c "STT_MODEL_NAME=$MODEL /opt/stt/venv/bin/python -c \"
import os, time
from faster_whisper import WhisperModel
started = time.time()
WhisperModel(os.environ['STT_MODEL_NAME'], device='cpu', compute_type='int8', download_root='/opt/stt/models')
print('model ready in %.1fs' % (time.time() - started))
\" 2>&1 | tail -3"
bx bash -c 'du -sh /opt/stt/models'

log "5. start the service"
bx bash -c 'systemctl daemon-reload; systemctl enable sage-stt >/dev/null 2>&1; systemctl restart sage-stt'
for _ in $(seq 1 40); do
  if bx bash -c "curl -fsS --max-time 3 http://127.0.0.1:$PORT/health >/dev/null"; then break; fi
  sleep 5
done
bx bash -c "curl -s --max-time 10 http://127.0.0.1:$PORT/health"; echo
bx bash -c 'systemctl is-active sage-stt'

log "6. point SAGE at the local route"
bx bash -c "grep -q '^STT_BASE_URL=' /opt/sage/.env && sed -i 's|^STT_BASE_URL=.*|STT_BASE_URL=http://127.0.0.1:$PORT/v1|' /opt/sage/.env || echo 'STT_BASE_URL=http://127.0.0.1:$PORT/v1' >> /opt/sage/.env"
bx bash -c "grep -q '^STT_API_KEY=' /opt/sage/.env && sed -i 's|^STT_API_KEY=.*|STT_API_KEY=local|' /opt/sage/.env || echo 'STT_API_KEY=local' >> /opt/sage/.env"
bx bash -c "grep -q '^STT_MODEL=' /opt/sage/.env && sed -i 's|^STT_MODEL=.*|STT_MODEL=$MODEL|' /opt/sage/.env || echo 'STT_MODEL=$MODEL' >> /opt/sage/.env"
bx bash -c 'systemctl restart sage'
sleep 4

log "7. end to end: speak with Kokoro, transcribe with Whisper"
bx bash -c 'curl -s --max-time 90 -X POST http://127.0.0.1:8880/synthesize -H "content-type: application/json" -d "{\"text\":\"The exam will cover chapters four through six, and the diagram question is worth ten marks.\",\"voice\":\"af_heart\"}" -o /tmp/stt-sample.wav -w "tts=%{http_code} bytes=%{size_download}\n"'
bx bash -c "curl -s --max-time 180 -X POST http://127.0.0.1:$PORT/v1/audio/transcriptions -F 'file=@/tmp/stt-sample.wav' -F 'model=$MODEL' -F 'language=en' -w '\nhttp=%{http_code}\n'"

log DONE
