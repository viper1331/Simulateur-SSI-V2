#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./manage.sh <command>

Commands:
  start          Installs dependencies, generates Prisma client, and starts the dev server.
  update         Safely checks available dependency updates without applying major upgrades.
  upgrade-major  Explicitly updates dependencies to latest versions. Use only after review.
  help           Shows this help message.
USAGE
}

ensure_workspace_root() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$SCRIPT_DIR"
}

run_pnpm() {
  corepack pnpm "$@"
}

start() {
  ensure_workspace_root
  run_pnpm install
  run_pnpm prisma:generate
  run_pnpm dev
}

update() {
  ensure_workspace_root
  run_pnpm install
  echo "Checking available dependency updates..."
  run_pnpm outdated || true
  cat <<'MESSAGE'

No dependency was upgraded automatically.
Review the list above, then update selected packages manually with:
  corepack pnpm update <package-name>

For a major upgrade pass, use:
  ./manage.sh upgrade-major

After any dependency update, run:
  corepack pnpm lint
  corepack pnpm typecheck
  corepack pnpm test
  corepack pnpm build
MESSAGE
}

upgrade_major() {
  ensure_workspace_root
  cat <<'WARNING'
WARNING: this command may install major dependency upgrades.
Run it only on a dedicated branch, then validate lint, typecheck, tests and build.
WARNING
  read -r -p "Continue with pnpm update --latest? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      run_pnpm install
      run_pnpm update --latest
      ;;
    *)
      echo "Upgrade cancelled."
      ;;
  esac
}

case "${1:-}" in
  start)
    start
    ;;
  update)
    update
    ;;
  upgrade-major)
    upgrade_major
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
