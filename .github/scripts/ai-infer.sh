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
# list). A free model is often down or rate-limited upstream, so each model
# is asked in turn, one request each, until one answers: a model that is gone
# or down does not fail the request. AI_MODEL and AI_FALLBACK_MODELS override
# them.
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
model=${AI_MODEL:-google/gemma-4-31b-it:free}
fallbacks=${AI_FALLBACK_MODELS:-nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-super-120b-a12b:free}
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

models=()
IFS=',' read -r -a listed <<< "$model,$fallbacks"
for listed_model in "${listed[@]}"; do
  listed_model=$(printf '%s' "$listed_model" | tr -d '[:space:]')
  if [ -n "$listed_model" ]; then
    models+=("$listed_model")
  fi
done

# The key goes to curl on stdin, so it is not in the process list. curl
# retries 429 and 5xx answers and honours Retry-After.
answered=""
for try_model in "${models[@]}"; do
  jq -n \
    --rawfile system "$system_file" \
    --rawfile user "$scratch/user.txt" \
    --arg model "$try_model" \
    '{
      model: $model,
      messages: [
        {role: "system", content: $system},
        {role: "user", content: $user}
      ],
      temperature: 0,
      max_tokens: 8192
    }' > "$scratch/request.json"

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
      echo "::warning::$try_model did not answer in ${timeout_seconds}s"
    else
      echo "::warning::The model API could not be reached for $try_model (curl exit $status)"
    fi
    continue
  fi

  error=$(jq -r '.error.message // empty' "$scratch/response.json" 2> /dev/null || true)
  if [ "$http_code" != "200" ] || [ -n "$error" ]; then
    echo "::warning::The model API answered HTTP $http_code for $try_model"
    if [ -n "$error" ]; then
      quote_log "${error:0:500}"
    fi
    continue
  fi
  answered=$try_model
  break
done

if [ -z "$answered" ]; then
  echo "::error::No model answered: ${models[*]}"
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
