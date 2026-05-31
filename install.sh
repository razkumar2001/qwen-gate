#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/youssefvdel/qwen-gate.git"
DIR="qwen-gate"

info()  { printf '\033[1;34m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────

command -v git  >/dev/null 2>&1 || fail "git is required but not installed"
command -v node >/dev/null 2>&1 || fail "Node.js is required but not installed"
command -v npm  >/dev/null 2>&1 || fail "npm is required but not installed"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js >= 18 required (found v${NODE_VER})"
fi
ok "Prerequisites met (Node.js v$(node -v), npm $(npm -v))"

# ── Clone ──────────────────────────────────────────────────────────

if [ -d "$DIR" ]; then
  info "$DIR/ already exists — pulling latest"
  git -C "$DIR" pull --ff-only
else
  info "Cloning $REPO"
  git clone "$REPO" "$DIR"
fi
ok "Repository ready"

# ── Install ────────────────────────────────────────────────────────

info "Installing dependencies"
npm install --prefix "$DIR"
ok "Dependencies installed"

info "Installing Playwright Chromium"
npx --prefix "$DIR" playwright install chromium
ok "Browser installed"

# ── Environment ────────────────────────────────────────────────────

if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  ok "Created .env from .env.example"
else
  ok ".env already exists — skipping"
fi

# ── Done ───────────────────────────────────────────────────────────

PORT=$(grep -E '^\s*PORT=' "$DIR/.env" | head -1 | cut -d= -f2 | tr -d ' ')
PORT="${PORT:-26405}"

printf '\n\033[1;32m╔══════════════════════════════════════════════╗\033[0m\n'
printf '\033[1;32m║       Qwen Gate installed successfully      ║\033[0m\n'
printf '\033[1;32m╚══════════════════════════════════════════════╝\033[0m\n\n'
printf '  Start:   \033[1mcd %s && npm start\033[0m\n' "$DIR"
printf '  API:     http://localhost:%s/v1\n' "$PORT"
printf '  Dashboard: http://localhost:%s/log\n' "$PORT"
printf '\n'
