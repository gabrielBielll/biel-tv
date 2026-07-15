#!/usr/bin/env python3
"""Transcreve um áudio (wav 16k mono) com faster-whisper.

Uso:
  python3 scripts/transcreve.py <audio.wav>           → texto puro no stdout
  python3 scripts/transcreve.py <audio.wav> --json    → segmentos COM TIMESTAMP

Códigos de saída:
  0 = ok · 2 = uso errado · 3 = faster-whisper não instalado (o pipeline trata
  como opcional e segue sem transcript — ver cli.mjs)

Modelo: small (multilíngue, int8) — bom equilíbrio pra PT-BR com trilha
sonora de comercial; baixa ~460MB no primeiro uso (cache do huggingface,
que o workflow da fábrica preserva entre runs).

── por que o --json existe ────────────────────────────────────────────────
O modo texto JOGA FORA o `.start`/`.end` que o faster-whisper já devolve em
cada segmento — e é justamente essa informação que o cortador de comerciais
(docs/features/cortador-comerciais.md) precisa: os BURACOS entre segmentos de
fala são os candidatos a limite entre um anúncio e o próximo, e o texto dos
dois lados é o que decide se o buraco é fronteira ou só uma pausa dramática.
Medido no acervo real (Jetix Intervalo Comercial, 600s): 164 segmentos de
fala; o DeepSeek lendo só o texto das bordas acertou 13/13 contra gabarito
anotado à mão. Nada de novo é computado aqui — só para de descartar na saída.

O modo texto continua sendo o default, byte a byte igual ao de antes: o
cli.mjs lê o stdout cru e não pode quebrar.
"""
import json
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}

if len(args) != 1 or not flags <= {"--json"}:
    print("uso: transcreve.py <audio.wav> [--json]", file=sys.stderr)
    sys.exit(2)

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("faster-whisper não instalado (pip install faster-whisper)", file=sys.stderr)
    sys.exit(3)

model = WhisperModel("small", device="cpu", compute_type="int8")
segments, _info = model.transcribe(args[0], language="pt", vad_filter=True)

# `segments` é um GERADOR (o faster-whisper só decodifica ao iterar): dá pra
# percorrer UMA vez só. Materializar aqui mantém os dois modos com um caminho
# de código só e sem risco de consumir o gerador duas vezes.
segs = [(seg.start, seg.end, seg.text.strip()) for seg in segments]

if "--json" in flags:
    json.dump(
        [{"start": round(s, 2), "end": round(e, 2), "text": t} for s, e, t in segs],
        sys.stdout,
        ensure_ascii=False,
    )
    print()
else:
    print(" ".join(t for _s, _e, t in segs).strip())
