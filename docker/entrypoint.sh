#!/usr/bin/env bash
# Shared entrypoint for the `app` and `e2e` containers.
#
# The repo is bind-mounted and every `node_modules` directory is masked by a
# named volume (see docker-compose.yml), so dependencies live inside the
# container and never collide with the host's install. This script makes the
# named volumes self-healing: it runs `pnpm install` only when the workspace is
# not already installed, then execs the requested command.
#
# Idempotent and cheap on warm volumes: the marker check skips reinstalling when
# node_modules is already populated, so repeated `make typecheck/test/lint` runs
# start fast.
set -euo pipefail

cd /workspace

if [ ! -d "node_modules/.pnpm" ]; then
  echo "[entrypoint] node_modules not found — installing with frozen lockfile…"
  pnpm install --frozen-lockfile
else
  echo "[entrypoint] node_modules present — skipping install."
fi

exec "$@"
