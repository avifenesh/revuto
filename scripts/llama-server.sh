#!/usr/bin/env bash
# Launch llama.cpp's OpenAI-compatible server as a reviewer provider.
#
# Build once (CUDA):
#   cmake -B "$HOME/projects/llama.cpp/build" -S "$HOME/projects/llama.cpp" -DGGML_CUDA=ON
#   cmake --build "$HOME/projects/llama.cpp/build" -j --target llama-server
#
# Run a chat model (default — full GPU offload, port 8080, tool-call parsing):
#   LLAMA_MODEL=/path/to/chat.gguf scripts/llama-server.sh
#
# Run an embedder (EMBED=1 — CPU by default to keep the GPU free, port 8181 so it
# stays clear of llama.cpp's own default 8080, CLS pooling for bge-* models):
#   EMBED=1 LLAMA_MODEL=~/models/embed/bge-small-en-v1.5-f16.gguf scripts/llama-server.sh
#
# Then point revuto.config.json at:
#   review/curator/distill: { "baseURL": "http://127.0.0.1:8080/v1", "model": "<served-name>" }
#   embedder:               { "baseURL": "http://127.0.0.1:8181/v1", "model": "<served-name>" }
#   (local endpoints need no apiKeyEnv)
#
# Overridable env: PORT, CTX, NGL (gpu layers), POOLING, LLAMA_ALIAS, LLAMA_DIR.
set -euo pipefail

LLAMA_DIR="${LLAMA_DIR:-$HOME/projects/llama.cpp}"
MODEL="${LLAMA_MODEL:?set LLAMA_MODEL=/path/to/model.gguf}"
EMBED="${EMBED:-0}"
ALIAS="${LLAMA_ALIAS:-$(basename "$MODEL" .gguf)}"

# Defaults differ for chat vs embedding instances.
if [ "$EMBED" = "1" ]; then
  PORT="${PORT:-8181}"      # off llama.cpp's default 8080
  CTX="${CTX:-512}"         # embeddings are short
  NGL="${NGL:-0}"           # CPU by default — keep the GPU free for chat models
  POOLING="${POOLING:-cls}" # bge-* use CLS pooling
else
  PORT="${PORT:-8080}"
  CTX="${CTX:-32768}"
  NGL="${NGL:-999}"      # full GPU offload
fi

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

# Embedding: --embedding + pooling. Chat: --jinja for the tool-call parsing the reviewer needs.
MODE=()
if [ "$EMBED" = "1" ]; then
  MODE=(--embedding --pooling "$POOLING")
else
  MODE=(--jinja)
fi
echo "serving $ALIAS on http://127.0.0.1:$PORT/v1 ($([ "$EMBED" = "1" ] && echo embedding || echo chat), ngl=$NGL) via $SERVER" >&2
exec "$SERVER" -m "$MODEL" --host 127.0.0.1 --port "$PORT" -ngl "$NGL" --ctx-size "$CTX" --alias "$ALIAS" "${MODE[@]}" "$@"
