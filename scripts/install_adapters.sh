#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install from https://docs.astral.sh/uv/getting-started/installation" >&2
  exit 1
fi

PYTHON_BIN="${PYTHON:-python3}"
uv venv --allow-existing --python "$PYTHON_BIN" .venv
uv sync

.venv/bin/python -m playwright install chromium

echo
echo "Installed project-local Python adapter dependencies in $ROOT/.venv"
echo "Optional adapter env vars:"
echo "  VIDEO_LEARNING_TIKTOK_API_CMD"
echo "  VIDEO_LEARNING_DOUYIN_API_CMD"
echo "  VIDEO_LEARNING_MEDIACRAWLER_CMD"
echo "  VIDEO_LEARNING_RES_DOWNLOADER_CMD"
echo "  VIDEO_LEARNING_WX_CHANNELS_CMD"
echo
echo "Run: bun run src/cli.ts adapters"
