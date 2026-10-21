#!/usr/bin/env bash
# Linux/macOS: build (if needed) and serve AI Networking Academy on http://127.0.0.1:8740.
set -euo pipefail
cd "$(dirname "$0")/../frontend"
command -v node >/dev/null || { echo "Node.js 20+ is required (https://nodejs.org)"; exit 1; }
[ -d node_modules ] || npm ci --no-audit --no-fund
if [ ! -f dist/index.html ] || [ -n "$(find ../content src scripts -newer dist/index.html -type f -print -quit)" ]; then
  npm run build
fi
exec npx vite preview --port "${PORT:-8740}" --strictPort --host 127.0.0.1
