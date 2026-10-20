#!/usr/bin/env bash
# Turns a .github/prompts/*.prompt.yml file into the two prompt files
# ai-infer.sh takes, with {{version}} and {{commits}} filled in.
#
#   bash .github/scripts/render-prompt.sh PROMPT_FILE VERSION COMMITS_FILE SYSTEM_OUT USER_OUT
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 PROMPT_FILE VERSION COMMITS_FILE SYSTEM_OUT USER_OUT" >&2
  exit 2
fi

prompt_file=$1
version=$2
commits_file=$3
system_out=$4
user_out=$5

yq '.messages[] | select(.role == "system") | .content' "$prompt_file" > "$system_out"
# Python, not bash ${//}: commit subjects may hold `&`, which bash 5.2
# replaces with the matched text.
yq '.messages[] | select(.role == "user") | .content' "$prompt_file" |
  python3 -c '
import sys
version = sys.argv[1]
with open(sys.argv[2], encoding="utf-8", errors="replace") as fh:
    commits = fh.read()
sys.stdout.write(sys.stdin.read().replace("{{version}}", version).replace("{{commits}}", commits))
' "$version" "$commits_file" > "$user_out"
