# Node + pnpm toolchain image for Interleave.
#
# Runs every non-browser task in CI and locally: `dev` (Vite), `typecheck`,
# `test` (Vitest), and `lint` (Biome). Browser E2E uses docker/Dockerfile.e2e.
#
# The Node version is pinned to match .nvmrc / package.json engines so Docker is
# the single canonical toolchain (no reliance on host Node).
FROM node:22.13.1-bookworm-slim

# Enable Corepack and pin pnpm to the version in package.json#packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.1 --activate

# pnpm stores its content-addressable store here; docker-compose mounts a named
# volume at this path so installs are cached across runs.
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN pnpm config set store-dir /pnpm/store --global

WORKDIR /workspace

# The repo is bind-mounted at runtime (see docker-compose.yml). Installing on
# first run keeps the image small and the source authoritative. Default command
# is overridden by the Makefile / compose `run` invocations.
CMD ["pnpm", "--filter", "@interleave/web", "dev"]
