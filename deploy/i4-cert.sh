#!/usr/bin/env bash
# Install a certificate for the public name into the SAGE container on i4.
#
#   bash deploy/i4-cert.sh /path/fullchain.pem /path/privkey.pem [public.name]
#
# Run from the host holding the i4move: remote. The certificate is checked
# against the public name before anything is replaced, so a wildcard for the
# wrong zone (the *.lab.innotel.us file staged in /opt/sage/certs) cannot be
# installed by accident and take the site down.
set -uo pipefail

R=i4move:
NAME=sage
CRT=${1:?usage: i4-cert.sh <fullchain.pem> <privkey.pem> [host]}
KEY=${2:?usage: i4-cert.sh <fullchain.pem> <privkey.pem> [host]}
HOST=${3:-sage.innotel.tech}

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "FAIL: $*" >&2; exit 1; }
bx() { for _ in 1 2 3 4 5 6 7 8; do timeout 30 incus exec "$R$NAME" -- "$@" 2>/dev/null && return 0; sleep 3; done; return 1; }

[ -f "$CRT" ] || die "no certificate at $CRT"
[ -f "$KEY" ] || die "no private key at $KEY"
openssl x509 -in "$CRT" -noout >/dev/null 2>&1 || die "not a certificate: $CRT"
if ! openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | grep -q "$HOST"; then
  die "certificate does not cover $HOST (SAN: $(openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | tail -1 | tr -d ' '))"
fi
log "certificate covers $HOST, expires $(openssl x509 -in "$CRT" -noout -enddate | cut -d= -f2)"

log "1. copy material"
base64 -w0 "$CRT" | timeout 90 incus exec "$R$NAME" -- bash -c 'base64 -d > /opt/sage/certs/fullchain.pem && chmod 644 /opt/sage/certs/fullchain.pem' 2>/dev/null \
  || die "copying the certificate failed"
base64 -w0 "$KEY" | timeout 90 incus exec "$R$NAME" -- bash -c 'base64 -d > /opt/sage/certs/privkey.pem && chmod 600 /opt/sage/certs/privkey.pem' 2>/dev/null \
  || die "copying the private key failed"

log "2. environment"
bx bash -c "grep -q '^TLS_CERT=' /opt/sage/.env || echo TLS_CERT=/opt/sage/certs/fullchain.pem >> /opt/sage/.env; grep -q '^TLS_KEY=' /opt/sage/.env || echo TLS_KEY=/opt/sage/certs/privkey.pem >> /opt/sage/.env; grep -q '^PORT=' /opt/sage/.env && sed -i 's|^PORT=.*|PORT=443|' /opt/sage/.env || echo PORT=443 >> /opt/sage/.env"
bx bash -c "grep -E '^(PORT|TLS_CERT|TLS_KEY)=' /opt/sage/.env"

log "3. restart"
bx systemctl restart sage || die "restart failed"
sleep 5
bx systemctl is-active sage

log "4. verify as a client would"
curl -s -m 15 -o /dev/null -w "   https://$HOST/api/health  http=%{http_code} verify=%{ssl_verify_result}\n" "https://$HOST/api/health" \
  || log "   public check failed - check DNS for $HOST"
curl -s -m 15 "https://$HOST/api/health" | head -c 200; echo
log DONE
