#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GSN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$GSN_DIR/.." && pwd)"

if [[ -f "$PARENT_DIR/gsn_agentes/gsn_cron_env.sh" ]]; then
  ENV_FILE="$PARENT_DIR/gsn_agentes/gsn_cron_env.sh"
  ROOT_DIR="$PARENT_DIR/gsn_agentes"
elif [[ -f "$PARENT_DIR/root/gsn_cron_env.sh" ]]; then
  ENV_FILE="$PARENT_DIR/root/gsn_cron_env.sh"
  ROOT_DIR="$PARENT_DIR/root"
else
  echo "Error: gsn_cron_env.sh not found!" >&2
  exit 1
fi

source "$ENV_FILE"
cd "$GSN_DIR"

if [[ -f tools/gsn_publish_paused.txt ]]; then
  pause_reason="$(head -c 240 tools/gsn_publish_paused.txt | tr '\n' ' ')"
  printf '[%s] GSN hourly publish skipped: publicacao automatica pausada (%s)\n' "$(date -Is)" "$pause_reason" >> logs/gsn_hourly_cron.log
  exit 0
fi

if [[ -f tools/loop_24h_until.txt ]]; then
  until_ts="$(cat tools/loop_24h_until.txt)"
  now_epoch="$(date +%s)"
  until_epoch="$(date -d "$until_ts" +%s 2>/dev/null || echo 0)"
  if [[ "$until_epoch" -gt 0 && "$now_epoch" -gt "$until_epoch" ]]; then
    printf '[%s] GSN hourly publish skipped: janela 24h encerrada em %s\n' "$(date -Is)" "$until_ts" >> logs/gsn_hourly_cron.log
    exit 0
  fi
fi

{
  printf '\n[%s] GSN hourly publish start\n' "$(date -Is)"
  "$GSN_PYTHON" -u scripts/gsn_zelador_destaques.py
  "$GSN_PYTHON" -u "$ROOT_DIR/gsn_smoke_markdown.py" 15 --queue
  "$GSN_PYTHON" -u "$ROOT_DIR/fix_brief_tags.py"
  
  # Upload new hero images to R2 and rewrite Markdown frontmatter to remote URLs
  "$GSN_PYTHON" -u "$ROOT_DIR/gsn_migrar_hero_r2.py" upload
  "$GSN_PYTHON" -u "$ROOT_DIR/gsn_migrar_hero_r2.py" rewrite

  "$GSN_NPM" run gsn:publish-hourly
  printf '[%s] GSN hourly publish done\n' "$(date -Is)"
} >> logs/gsn_hourly_cron.log 2>&1
