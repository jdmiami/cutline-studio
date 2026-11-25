#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${CUTLINE_DATA_ROOT:=/workspace/cutline-data}"
export HELIOS_ROOT="$CUTLINE_DATA_ROOT"
export HELIOS_PYTHON="$HELIOS_ROOT/helios-env/bin/python"
export HELIOS_MODEL_DIR="$HELIOS_ROOT/Helios-Distilled"
export PORT="${PORT:-8765}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
exec node pod-server.mjs
