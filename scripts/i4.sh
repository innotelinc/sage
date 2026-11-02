#!/usr/bin/env bash
# Talk to the i4 incus remote without tripping over its flakiness.
#
# The TLS remote at 192.168.1.54:8443 drops connections at random — "read: tcp
# ...: connection reset by peer" — often enough that a multi-step deploy fails
# in the middle. ARP is stable (one MAC, no duplicate responder) and a 1472-byte
# no-fragment ping succeeds, so it is neither an IP conflict nor an MTU problem:
# the daemon simply resets some TLS connections. Every call is therefore retried
# with backoff instead of being written off.
#
#   scripts/i4.sh exec sage -- systemctl is-active sage
#   scripts/i4.sh push sage /opt/sage /opt/sage      (directory, recursive)
#   scripts/i4.sh run  sage 'curl -s http://127.0.0.1:8881/health'
set -uo pipefail

REMOTE="${I4_REMOTE:-i4move:}"
ATTEMPTS="${I4_ATTEMPTS:-8}"

retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge "$ATTEMPTS" ]; then
      echo "i4: giving up after $ATTEMPTS attempts" >&2
      return 1
    fi
    echo "i4: attempt $n failed, retrying in $((n * 2))s" >&2
    sleep $((n * 2))
  done
}

action="${1:-}"
shift || true

case "$action" in
  exec)
    instance="${1:?instance required}"; shift
    [ "${1:-}" = "--" ] && shift
    retry incus exec "$REMOTE$instance" -- "$@"
    ;;
  run)
    instance="${1:?instance required}"; shift
    command="${*:?command required}"
    retry incus exec "$REMOTE$instance" -- bash -c "$command"
    ;;
  push)
    instance="${1:?instance required}"; src="${2:?source required}"; dest="${3:?destination required}"
    retry bash -c "tar -czf - -C '$src' . | incus exec '$REMOTE$instance' -- tar -xzf - -C '$dest'"
    ;;
  *)
    echo "usage: $0 exec <instance> -- <command> | run <instance> <shell command> | push <instance> <src> <dest>" >&2
    exit 2
    ;;
esac
