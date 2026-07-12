#!/usr/bin/env bash
# Gera mídia de teste da fase 1: um "episódio" de 120s e um "comercial" de 20s,
# já segmentados em .ts de exatamente 10s (force_key_frames), com timecode
# queimado no vídeo para a troca de programa ser visível a olho nu.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.media-test"

FF="${FFMPEG:-}"
if [ -z "$FF" ]; then
  if command -v ffmpeg >/dev/null 2>&1; then FF=ffmpeg
  elif [ -x "$HOME/.local/bin/ffmpeg" ]; then FF="$HOME/.local/bin/ffmpeg"
  else echo "ffmpeg não encontrado (instale ou exporte FFMPEG=/caminho)" >&2; exit 1; fi
fi

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

gen() {
  local id="$1" dur="$2" label="$3" src="$4" freq="$5"
  local dir="$OUT/$id"
  rm -rf "$dir" && mkdir -p "$dir"

  local vf="null"
  # grep sem -q: com pipefail, o -q sairia cedo e o SIGPIPE no ffmpeg
  # derrubaria a condição mesmo com o filtro presente
  if [ -f "$FONT" ] && "$FF" -hide_banner -filters 2>/dev/null | grep ' drawtext ' >/dev/null; then
    vf="drawtext=fontfile=$FONT:text='$label  %{pts\:hms}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black:x=(w-tw)/2:y=(h-th)/2"
  fi

  "$FF" -hide_banner -loglevel error -y \
    -f lavfi -i "$src=size=1280x720:rate=30" \
    -f lavfi -i "sine=frequency=$freq:sample_rate=48000" \
    -t "$dur" -vf "$vf" \
    -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -sc_threshold 0 \
    -force_key_frames "expr:gte(t,n_forced*10)" \
    -c:a aac -b:a 128k -ac 2 \
    -f hls -hls_time 10 -hls_list_size 0 -hls_flags independent_segments \
    -hls_segment_filename "$dir/seg%05d.ts" "$dir/_index.m3u8"

  rm -f "$dir/_index.m3u8"
  echo "→ $id: $(ls "$dir" | wc -l) segmentos (${dur}s de '$label')"
}

# perfil único do canal: 720p H.264 high + AAC 128k 48kHz stereo
gen ep_test  120 "EPISODIO TESTE" testsrc2    440
gen com_test  20 "COMERCIAL"      smptehdbars 880

echo
echo "Durações reais (devem ser ~10.0s cada):"
FP="${FF%ffmpeg}ffprobe"; command -v "$FP" >/dev/null 2>&1 || FP="$HOME/.local/bin/ffprobe"
for f in "$OUT"/*/seg00000.ts "$OUT"/ep_test/seg00011.ts; do
  d=$("$FP" -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null || echo '?')
  echo "  $(basename "$(dirname "$f")")/$(basename "$f"): ${d}s"
done
