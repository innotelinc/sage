#!/usr/bin/env bash
# Provision SAGE as an incus container on i4 (192.168.1.54).
#
# Run from the host that holds the incus TLS remote (`i4move:`) and the existing
# /opt/sage tree. i4's incus API drops connections on a lossy link, so every call
# is timeout-bounded, and the script is safe to re-run.
#
#   scp deploy/i4-provision.sh dev:/root/ && ssh dev 'bash /root/i4-provision.sh'
set -uo pipefail

NAME=sage
R=i4move:
IP=192.168.1.94
GW=192.168.1.1
DNS=192.168.1.71
IMAGE=8d7438a6bf45   # ubuntu noble, cached on i4

log() { echo "[$(date +%H:%M:%S)] $*"; }
exists() {
  timeout 25 incus list "$R" --format csv -c n 2>/dev/null | tr -d '\r' | grep -qx "$NAME"
}
bx() { timeout 90 incus exec "$R$NAME" -- "$@" 2>/dev/null; }
bxr() {
  local n=0
  while :; do
    bx "$@" && return 0
    n=$((n + 1))
    if [ "$n" -ge 12 ]; then log "   gave up: $*"; return 1; fi
    sleep 5
  done
}

log "0. wait for i4 API"
for _ in $(seq 1 24); do timeout 20 incus list "$R" --format csv -c n >/dev/null 2>&1 && break; sleep 5; done

log "1. instance"
if exists; then
  log "   already exists"
else
  for _ in 1 2 3 4 5; do
    timeout 180 incus launch "$R$IMAGE" "$R$NAME" -p default -p small >/dev/null 2>&1
    exists && break
    sleep 5
  done
  exists && log "   launched" || { log "   LAUNCH FAILED"; exit 1; }
fi
timeout 60 incus start "$R$NAME" >/dev/null 2>&1 || true

log "2. agent"
for _ in $(seq 1 24); do bx true && break; sleep 5; done
bx true || { log "   agent unreachable"; exit 1; }

log "3. static $IP"
bxr bash -c "cat > /etc/netplan/60-sage.yaml <<'EOF'
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: false
      addresses: [$IP/24]
      routes:
        - to: default
          via: $GW
      nameservers:
        addresses: [$DNS, 1.1.1.1]
EOF
chmod 600 /etc/netplan/60-sage.yaml
netplan apply"
sleep 4
bx ip -4 -o addr show eth0 2>/dev/null | sed 's/^/   /'

log "4. node"
if ! bx bash -c 'command -v node' >/dev/null 2>&1; then
  bxr bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq'
  bxr bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq ca-certificates curl tar'
  bxr bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  bxr bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq nodejs'
fi
log "   node $(bx node -v)"

log "5. payload"
bxr mkdir -p /opt/sage /opt/sage/certs /opt/sage/threads
tar -czf - -C /opt/sage --exclude=certs --exclude=.env --exclude=threads . 2>/dev/null \
  | timeout 120 incus exec "$R$NAME" -- tar -xzf - -C /opt/sage 2>/dev/null
log "   $(bx bash -c 'ls /opt/sage | tr "\n" " "')"

log "6. secrets + certificate"
base64 -w0 /opt/sage/.env | timeout 90 incus exec "$R$NAME" -- bash -c 'base64 -d > /opt/sage/.env && chmod 600 /opt/sage/.env' 2>/dev/null
# The Docker deployment mounts its certificate at /app/certs; here the tree is /opt/sage.
bxr bash -c "sed -i -e 's|^TLS_CERT=.*|TLS_CERT=/opt/sage/certs/fullchain.pem|' -e 's|^TLS_KEY=.*|TLS_KEY=/opt/sage/certs/privkey.pem|' /opt/sage/.env"
base64 -w0 /opt/sage/certs/fullchain.pem | timeout 90 incus exec "$R$NAME" -- bash -c 'base64 -d > /opt/sage/certs/fullchain.pem && chmod 644 /opt/sage/certs/fullchain.pem' 2>/dev/null
base64 -w0 /opt/sage/certs/privkey.pem | timeout 90 incus exec "$R$NAME" -- bash -c 'base64 -d > /opt/sage/certs/privkey.pem && chmod 600 /opt/sage/certs/privkey.pem' 2>/dev/null
log "   certs: $(bx bash -c 'ls /opt/sage/certs | tr "\n" " "')"

log "7. unit"
NODEBIN=$(bx bash -c 'command -v node')
bxr bash -c "cat > /etc/systemd/system/sage.service <<'EOF'
[Unit]
Description=SAGE — course-taking agent (Innotel Labs)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/sage
EnvironmentFile=/opt/sage/.env
ExecStart=$NODEBIN /opt/sage/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable sage
systemctl restart sage"
sleep 6
log "   service: $(bx systemctl is-active sage)"

log "8. health"
curl -sS -m 12 --resolve "sage.lab.innotel.us:8443:$IP" https://sage.lab.innotel.us:8443/api/health \
  -w '\n   http=%{http_code} verify=%{ssl_verify_result}\n' 2>&1 | head -3

log "9. autostart"
timeout 30 incus config set "$R$NAME" boot.autostart true >/dev/null 2>&1 || true
timeout 30 incus list "$R" --format compact 2>/dev/null | grep -E "NAME|$NAME"
log "DONE"
