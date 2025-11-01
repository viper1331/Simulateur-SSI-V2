#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./manage.sh <command>

Commands:
  start       Installs dependencies, generates Prisma client, and starts the dev server.
  update      Updates project dependencies to their latest compatible versions.
  help        Shows this help message.
USAGE
}

ensure_workspace_root() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$SCRIPT_DIR"
}

start() {
  ensure_workspace_root
  pnpm install
  pnpm prisma:generate
  pnpm dev
}

update() {
  ensure_workspace_root
  pnpm install
  pnpm update --latest
}

case "${1:-}" in
  start)
    start
    ;;
  update)
    update
    ;;
  help|""|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac

