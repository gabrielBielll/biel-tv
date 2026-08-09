#!/usr/bin/env bash
# Drena a fila de ingestão da Biel TV AQUI (celular/PC), sem depender dos
# minutos do GitHub Actions. É um atalho em torno de scripts/factory-local.mjs:
# aponta pro Worker de produção, grava no D1/R2 de verdade e baixa do YouTube
# com os cookies do painel (sem bot-check). Idempotente e retomável — cada job
# concluído sai da fila; rode de novo pra continuar de onde parou.
#
# Uso:   bash scripts/drena-local.sh
# Requer: node, ffmpeg, e o yt-dlp do pip com plugin ejs
#         (pip install -U "yt-dlp[default]" yt-dlp-ejs)
#         + credenciais em ~/bieltv-cred.env (R2_*, CLOUDFLARE_*, ADMIN_TOKEN).
#
# Variáveis (todas opcionais, com padrão sensato):
#   BASE           Worker alvo         (default: produção)
#   FACTORY_DRAIN  1=drena e sai · 0=daemon de polling  (default: 1)
#   YTDLP_CMD      comando do yt-dlp   (default: "python3 -m yt_dlp")
#   CRED_ENV       arquivo de creds    (default: ~/bieltv-cred.env)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_ENV="${CRED_ENV:-$HOME/bieltv-cred.env}"

if [ -f "$CRED_ENV" ]; then
  set -a; . "$CRED_ENV"; set +a
else
  echo "⚠️  $CRED_ENV não encontrado — exporte R2_*, CLOUDFLARE_* e ADMIN_TOKEN antes de rodar." >&2
fi

# alvo remoto + D1 via HTTP (o wrangler não roda no Termux) + yt-dlp do pip
export BASE="${BASE:-https://biel-tv-stream.biel-cesa95.workers.dev}"
export FACTORY_TARGET=remote
export FACTORY_DRAIN="${FACTORY_DRAIN:-1}"
export D1_HTTP="${D1_HTTP:-1}"
export YTDLP_CMD="${YTDLP_CMD:-python3 -m yt_dlp}"

falta=0
command -v node >/dev/null    || { echo "✖ node não encontrado" >&2; falta=1; }
command -v ffmpeg >/dev/null  || { echo "✖ ffmpeg não encontrado" >&2; falta=1; }
$YTDLP_CMD --version >/dev/null 2>&1 || { echo "✖ yt-dlp ($YTDLP_CMD) não funciona — pip install -U 'yt-dlp[default]' yt-dlp-ejs" >&2; falta=1; }
: "${ADMIN_TOKEN:?defina ADMIN_TOKEN (no $CRED_ENV ou no ambiente)}"
[ "$falta" = 0 ] || exit 1

echo "▶ drenando a fila de $BASE  [target=remote, drain=$FACTORY_DRAIN, yt-dlp='$YTDLP_CMD']"
exec node "$ROOT/scripts/factory-local.mjs"
