#!/usr/bin/env python3
"""Transcreve um áudio (wav 16k mono) com faster-whisper e imprime o texto.

Uso: python3 scripts/transcreve.py <audio.wav>
Saída: texto puro no stdout. Códigos de saída:
  0 = ok · 3 = faster-whisper não instalado (o pipeline trata como opcional)

Modelo: small (multilíngue, int8) — bom equilíbrio pra PT-BR com trilha
sonora de comercial; baixa ~460MB no primeiro uso (cache do huggingface,
que o workflow da fábrica preserva entre runs).
"""
import sys

if len(sys.argv) != 2:
    print("uso: transcreve.py <audio.wav>", file=sys.stderr)
    sys.exit(2)

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("faster-whisper não instalado (pip install faster-whisper)", file=sys.stderr)
    sys.exit(3)

model = WhisperModel("small", device="cpu", compute_type="int8")
segments, _info = model.transcribe(sys.argv[1], language="pt", vad_filter=True)
texto = " ".join(seg.text.strip() for seg in segments).strip()
print(texto)
