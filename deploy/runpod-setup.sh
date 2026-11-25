#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v node >/dev/null || { echo "Install Node 22 or newer first." >&2; exit 1; }
command -v uv >/dev/null || { echo "Install uv from https://docs.astral.sh/uv/ first." >&2; exit 1; }
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
: "${CUTLINE_DATA_ROOT:=/workspace/cutline-data}"
mkdir -p "$CUTLINE_DATA_ROOT"
env_root="$CUTLINE_DATA_ROOT/helios-env"
uv venv --python 3.11 "$env_root"
uv pip install --python "$env_root/bin/python" --index-url https://download.pytorch.org/whl/cu128 torch==2.9.1
uv pip install --python "$env_root/bin/python" diffusers==0.43.0 transformers==4.57.3 accelerate==1.12.0 sentencepiece pillow
"$env_root/bin/python" -c 'from diffusers import HeliosPyramidPipeline; import torch; assert torch.cuda.is_available(), "CUDA is not available"'
"$env_root/bin/hf" download BestWishYsh/Helios-Distilled --local-dir "$CUTLINE_DATA_ROOT/Helios-Distilled"
printf 'Helios installed. Next: bash deploy/runpod-start.sh (see README).\n'
