#!/usr/bin/env bash
# Vigia da fila de ingestão: 1 linha por MUDANÇA, alerta se TRAVAR, sai quando
# drena. Feito pra rodar sob o Monitor do Claude Code (cada linha de stdout vira
# uma notificação), mas serve como watch de terminal também.
#
# "Travou" = sem avançar por ~STALL_TICKS ciclos E nada processando — o sinal
# clássico de que os minutos do Actions acabaram ou a run morreu, hora de drenar
# localmente (scripts/drena-local.sh).
#
# Uso:  bash scripts/monitora-fila.sh
# Env (opcionais): CRED_ENV (~/bieltv-cred.env) · POLL_S (120) · STALL_TICKS (5)
#                  WINDOW_H (12) janela de jobs recentes considerada
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_ENV="${CRED_ENV:-$HOME/bieltv-cred.env}"
[ -f "$CRED_ENV" ] && { set -a; . "$CRED_ENV"; set +a; }
: "${CLOUDFLARE_ACCOUNT_ID:?defina CLOUDFLARE_ACCOUNT_ID}"; : "${CLOUDFLARE_API_TOKEN:?defina CLOUDFLARE_API_TOKEN}"

DBID="${D1_DATABASE_ID:-$(grep -m1 'database_id' "$ROOT/apps/stream/wrangler.toml" | sed 's/.*"\(.*\)"/\1/')}"
POLL_S="${POLL_S:-120}"; STALL_TICKS="${STALL_TICKS:-5}"; WINDOW_H="${WINDOW_H:-12}"
URL="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$DBID/query"
SQL="SELECT status, COUNT(*) n FROM ingest_jobs WHERE created_at > unixepoch()-$((WINDOW_H*3600)) GROUP BY status"

prev=""; stall=0; alerted=0
while true; do
  linha=$(curl -s -m 30 "$URL" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
    --data "{\"sql\":\"$SQL\"}" 2>/dev/null | python3 -c '
import json,sys
try:
  m={r["status"]:r["n"] for r in json.load(sys.stdin)["result"][0]["results"]}
  print("%d %d %d" % (m.get("done",0), m.get("processing",0), m.get("queued",0)))
except Exception: print("ERR")' )
  [ "$linha" = "ERR" ] && { sleep "$POLL_S"; continue; }   # API tossiu: não conta como travamento
  read done proc queued <<<"$linha"

  if [ "$queued" = 0 ] && [ "$proc" = 0 ]; then
    echo "fila drenada: $done concluídos"; exit 0
  fi
  sig="$done/$proc/$queued"
  if [ "$sig" != "$prev" ]; then
    echo "fila: done=$done processing=$proc queued=$queued"
    prev="$sig"; stall=0; alerted=0
  else
    stall=$((stall+1))
    if [ "$stall" -ge "$STALL_TICKS" ] && [ "$proc" = 0 ] && [ "$alerted" = 0 ]; then
      echo "⚠️ TRAVOU: done=$done parado há ~$((STALL_TICKS*POLL_S/60))min, nada processando, $queued na fila — Actions provavelmente esgotou. Rode: bash scripts/drena-local.sh"
      alerted=1
    fi
  fi
  sleep "$POLL_S"
done
