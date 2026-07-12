#!/usr/bin/env bash
# Sobe os segmentos de .media-test/ para o R2 SIMULADO LOCAL do wrangler
# (.wrangler/state em apps/stream). Não toca em nenhum bucket real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/stream"

shopt -s nullglob
files=("$ROOT"/.media-test/*/*.ts)
if [ ${#files[@]} -eq 0 ]; then
  echo "nenhum segmento em .media-test/ — rode antes: pnpm media:test" >&2
  exit 1
fi

for f in "${files[@]}"; do
  id="$(basename "$(dirname "$f")")"
  key="media/$id/$(basename "$f")"
  npx wrangler r2 object put "biel-tv-media/$key" --file "$f" --local >/dev/null 2>&1
  echo "R2(local) ← $key"
done
echo "ok: ${#files[@]} objetos"
