#!/usr/bin/env bash
# Sends one prompt to a free OpenRouter model and writes the answer to a file.
#
#   bash .github/scripts/ai-infer.sh SYSTEM_PROMPT_FILE USER_PROMPT_FILE OUTPUT_FILE
#
# Needs the OPENROUTER_API_KEY secret in AI_API_KEY. GitHub Models was retired
# on 2026-07-30, and Copilot through the workflow token needs an org policy
# that bills the org.
#
# Free models allow 20 requests a minute and 1000 a day (the account has
# bought credits), and the free list changes: when a model goes, pick another
# `:free` id from https://openrouter.ai/models (i18n-review.yml has the same
# list). A free model is often rate-limited upstream, so OpenRouter tries the
# fallbacks in order. AI_MODEL and AI_FALLBACK_MODELS override them.
#
# The user prompt is cut to AI_PROMPT_MAX_BYTES, so put the least important
# context at its end.
#
# Exits 0 with a non-empty answer in OUTPUT_FILE, 1 otherwise. The caller
# decides how to degrade. Nothing the model or the prompt says is printed to
# the log without `::stop-commands::` around it, because a log line that
# starts with `::` is a workflow command.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 SYSTEM_PROMPT_FILE USER_PROMPT_FILE OUTPUT_FILE" >&2
  exit 2
fi

system_file=$1
user_file=$2
out_file=$3
api_url=${AI_API_URL:-https://openrouter.ai/api/v1/chat/completions}
model=${AI_MODEL:-nvidia/nemotron-3-super-120b-a12b:free}
fallbacks=${AI_FALLBACK_MODELS:-minimax/minimax-m3.1-flash:free,google/gemma-4-31b-it:free}
max_bytes=${AI_PROMPT_MAX_BYTES:-120000}
timeout_seconds=${AI_TIMEOUT_SECONDS:-300}

: > "$out_file"

if [ -z "${AI_API_KEY:-}" ]; then
  echo "::error::AI_API_KEY is not set (the OPENROUTER_API_KEY secret)"
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# Prints untrusted text without letting a line act as a workflow command.
quote_log() {
  local stop_token
  stop_token="ai-infer-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  echo "::stop-commands::$stop_token"
  printf '%s\n' "$1"
  echo "::$stop_token::"
}

user_bytes=$(wc -c < "$user_file")
if [ "$user_bytes" -gt "$max_bytes" ]; then
  echo "::warning::User prompt cut from $user_bytes to $max_bytes bytes"
fi
# A cut can split a UTF-8 sequence; iconv -c drops the broken tail (and exits
# 1 when it does).
head -c "$max_bytes" "$user_file" | tr -d '\000' |
  { iconv -f UTF-8 -t UTF-8 -c 2> /dev/null || true; } > "$scratch/user.txt"

jq -n \
  --rawfile system "$system_file" \
  --rawfile user "$scratch/user.txt" \
  --arg model "$model" \
  --arg fallbacks "$fallbacks" \
  '{
    model: $model,
    models: ([$model] + ($fallbacks | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)))),
    messages: [
      {role: "system", content: $system},
      {role: "user", content: $user}
    ],
    temperature: 0,
    max_tokens: 8192
  }' > "$scratch/request.json"

# The key goes to curl on stdin, so it is not in the process list. curl
# retries 429 and 5xx answers and honours Retry-After.
status=0
http_code=$(
  printf 'header = "Authorization: Bearer %s"\n' "$AI_API_KEY" |
    curl -sS --config - \
      --max-time "$timeout_seconds" \
      --retry 2 --retry-max-time 120 \
      -H "Content-Type: application/json" \
      --data-binary "@$scratch/request.json" \
      -o "$scratch/response.json" \
      -w '%{http_code}' \
      "$api_url"
) || status=$?

if [ "$status" -ne 0 ]; then
  if [ "$status" -eq 28 ]; then
    echo "::error::The model API did not answer in ${timeout_seconds}s"
  else
    echo "::error::The model API could not be reached (curl exit $status)"
  fi
  exit 1
fi

error=$(jq -r '.error.message // empty' "$scratch/response.json" 2> /dev/null || true)
if [ "$http_code" != "200" ] || [ -n "$error" ]; then
  echo "::error::The model API answered HTTP $http_code"
  if [ -n "$error" ]; then
    quote_log "${error:0:500}"
  fi
  exit 1
fi

if ! jq -j '.choices[0].message.content // empty' "$scratch/response.json" > "$out_file" 2> /dev/null; then
  echo "::error::The model API returned a body that is not JSON"
  exit 1
fi

if [ -z "$(tr -d '[:space:]' < "$out_file")" ]; then
  echo "::error::The model returned an empty answer"
  exit 1
fi

answered_by=$(jq -r '.model // "unknown"' "$scratch/response.json")
echo "Model $answered_by answered with $(wc -c < "$out_file") bytes"
