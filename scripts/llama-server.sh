#!/usr/bin/env bash
# Launch llama.cpp's OpenAI-compatible server as a reviewer provider.
#
# Build once (CUDA):
#   cmake -B "$HOME/projects/llama.cpp/build" -S "$HOME/projects/llama.cpp" -DGGML_CUDA=ON
#   cmake --build "$HOME/projects/llama.cpp/build" -j --target llama-server
#
# Run:
#   LLAMA_MODEL=/path/to/model.gguf scripts/llama-server.sh [--port 8080]
#
# Then point reviewer.config.json models at:
#   { "baseURL": "http://127.0.0.1:8080/v1", "model": "<served-name>" }   # no apiKeyEnv needed
set -euo pipefail

LLAMA_DIR="${LLAMA_DIR:-$HOME/projects/llama.cpp}"
MODEL="${LLAMA_MODEL:?set LLAMA_MODEL=/path/to/model.gguf}"
PORT="${PORT:-8080}"
CTX="${CTX:-32768}"
ALIAS="${LLAMA_ALIAS:-$(basename "$MODEL" .gguf)}"

# Use the first prebuilt binary among the known CUDA build dirs.
SERVER=""
for d in build-cuda13-clean build-cuda13-graphs build-cuda build; do
  if [ -x "$LLAMA_DIR/$d/bin/llama-server" ]; then SERVER="$LLAMA_DIR/$d/bin/llama-server"; break; fi
done
if [ -z "$SERVER" ]; then
  echo "no prebuilt llama-server under $LLAMA_DIR/{build-cuda13-clean,build-cuda,build}" >&2
  echo "build: cmake -B \"$LLAMA_DIR/build-cuda13-clean\" -S \"$LLAMA_DIR\" -DGGML_CUDA=ON && cmake --build \"$LLAMA_DIR/build-cuda13-clean\" -j --target llama-server" >&2
  exit 1
fi

# --jinja enables the chat template's tool-call parsing, which the reviewer needs.
# --embedding mode is a separate instance; pass EMBED=1 to enable it.
EXTRA=()
[ "${EMBED:-0}" = "1" ] && EXTRA+=(--embedding --pooling mean)
echo "serving $ALIAS on http://127.0.0.1:$PORT/v1 via $SERVER" >&2
exec "$SERVER" -m "$MODEL" --host 127.0.0.1 --port "$PORT" -ngl 999 --jinja --ctx-size "$CTX" --alias "$ALIAS" "${EXTRA[@]}" "$@"
