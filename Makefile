# Interleave — canonical task commands (Docker-first).
#
# Everything runs in Docker so there is no reliance on host Node/pnpm versions.
# Each target shells out to `docker compose run --rm app …` (or `e2e`). The
# container entrypoint (docker/entrypoint.sh) installs dependencies on first run
# and is a no-op on warm volumes, so repeated checks start fast.
#
# This file defines the `make` command contract referenced by the Definition of
# Done in CLAUDE.md and the table in docs/architecture.md. Keep them in sync.

# `docker compose run` flags:
#   --rm        remove the one-off container when it exits
#   --no-deps   don't start linked services (the MVP `app`/`e2e` have none, but
#               this keeps one-off checks fast and isolated)
COMPOSE        := docker compose
RUN_APP        := $(COMPOSE) run --rm --no-deps app
RUN_E2E        := $(COMPOSE) run --rm --no-deps e2e

.DEFAULT_GOAL := help

.PHONY: help dev typecheck test e2e lint format seed migrate shell down build

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev: ## Start the dev stack (Vite) with hot reload at http://localhost:5173
	$(COMPOSE) up app

build: ## Build the Docker images (app + e2e)
	$(COMPOSE) build

typecheck: ## Typecheck the whole workspace (in a container)
	$(RUN_APP) pnpm typecheck

test: ## Run Vitest unit/domain tests (in a container)
	$(RUN_APP) pnpm test

lint: ## Run Biome format + lint check (JS/TS/JSON/CSS)
	$(RUN_APP) pnpm lint

format: ## Auto-format the workspace with Biome
	$(RUN_APP) pnpm format

e2e: ## Run the Playwright smoke E2E (official Playwright image)
	$(RUN_E2E) pnpm e2e

seed: ## Load demo fixtures into the local DB (stub until T009)
	@echo "make seed: no seed script yet — implemented in T009 (Seed data & fixtures)."

migrate: ## Run Drizzle migrations (stub until the server DB arrives)
	@echo "make migrate: no migrations yet — local PGlite migrations land in T006/T007; server migrations in M11."

shell: ## Open an interactive shell in the toolchain container
	$(COMPOSE) run --rm --no-deps --entrypoint bash app

down: ## Stop the stack and remove containers/networks
	$(COMPOSE) down
