#!/usr/bin/env bash
# Reenquadra um filme que já está no ar para 16:9 cheio, sem tarja.
#
# Baixa os segmentos atuais (pelo Worker), corta a tarja (`CROP`, medido antes
# pelo levantamento), amplia até cobrir 1280x720 e re-segmenta com o mesmo
# perfil da fábrica (keyint de 300 quadros = .ts de 10s exatos). A duração e o
# número de segmentos não mudam, então os cue points de intervalo continuam
# valendo.
#
# NÃO sobrescreve nada e NÃO mexe no D1: grava em media/<id>_169/ (o cache do
# /media/* é immutable por 1 ano — regravar a mesma chave não chegaria ao ar).
# Quem troca o path_prefix no D1 é um passo separado, depois da revisão; o
# caminho antigo continua sendo o backup. Ver docs/PROCESSO_COMERCIAIS_16X9.md.
#
# uso: reenquadra-filme.sh <media_id> <path_prefix> <segment_count> <duracao_seg> <crop W:H:X:Y>
# env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
set -euo pipefail

ID=$1 PREFIX=$2 N=$3 DUR=$4 CROP=$5
ORIGEM=https://biel-tv-stream.biel-cesa95.workers.dev
NOVO="${PREFIX}_169"
BACKUP="backup/ajuste-169-filmes-2026-10-17/${ID}"
WD=${RUNNER_TEMP:-/tmp}/reenquadra/$ID
rm -rf "$WD" && mkdir -p "$WD/old" "$WD/out" "$WD/thumbs"

export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
R2="--endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo "1/5 baixando $N segmentos de $PREFIX"
seq 0 $((N - 1)) | xargs -P 16 -I{} sh -c \
  'f=$(printf "seg%05d.ts" {}); curl -sf --retry 4 -A "curl/8.5.0" -o "'"$WD"'/old/$f" "'"$ORIGEM/$PREFIX"'/$f"'
[ "$(ls "$WD/old" | wc -l)" -eq "$N" ] || { echo "faltam segmentos"; exit 1; }
cat "$WD"/old/seg*.ts > "$WD/src.ts" && rm -rf "$WD/old"

echo "2/5 reenquadrando (crop $CROP → cobre 1280x720)"
ffmpeg -nostdin -y -hide_banner -loglevel error -i "$WD/src.ts" -t "$DUR" \
  -vf "crop=$CROP,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,format=yuv420p" \
  -af aresample=48000,apad \
  -c:v libx264 -preset veryfast -crf 20 -profile:v high -x264-params keyint=300:min-keyint=300:scenecut=0 \
  -c:a aac -b:a 128k -ac 2 "$WD/norm.mp4"

echo "3/5 segmentando"
ffmpeg -nostdin -y -hide_banner -loglevel error -i "$WD/norm.mp4" -c copy -f hls -hls_time 10 \
  -hls_list_size 0 -hls_flags independent_segments \
  -hls_segment_filename "$WD/out/seg%05d.ts" "$WD/out/_index.m3u8"

echo "4/5 validando"
GERADOS=$(grep -c '^#EXTINF' "$WD/out/_index.m3u8")
[ "$GERADOS" -eq "$N" ] || { echo "gerou $GERADOS segmentos, esperava $N"; exit 1; }
# todo .ts com 10s (±50ms), o último pode ter 1 quadro a menos
grep -oE '^#EXTINF:[0-9.]+' "$WD/out/_index.m3u8" | cut -d: -f2 | head -n -1 \
  | awk '{ if ($1 < 9.95 || $1 > 10.05) { print "segmento fora de 10s: " $1; bad = 1 } } END { exit bad }'

echo "5/5 enviando para $NOVO"
aws s3 cp $R2 --recursive --only-show-errors --exclude '_index.m3u8' --content-type video/mp2t \
  "$WD/out/" "s3://biel-tv-media/$NOVO/"
for p in 20 45 70; do
  t=$(awk -v d="$DUR" -v p="$p" 'BEGIN { printf "%.1f", d * p / 100 }')
  ffmpeg -nostdin -y -v error -ss "$t" -i "$WD/src.ts" -frames:v 1 -vf scale=480:-2 "$WD/thumbs/antes_$p.jpg"
  ffmpeg -nostdin -y -v error -ss "$t" -i "$WD/norm.mp4" -frames:v 1 -vf scale=480:-2 "$WD/thumbs/depois_$p.jpg"
done
aws s3 cp $R2 --recursive --only-show-errors "$WD/thumbs/" "s3://biel-tv-media/$BACKUP/"
echo "✔ $ID → $NOVO ($GERADOS segmentos)"
rm -rf "$WD"
