#!/usr/bin/env python
"""Transcribe a recording with word-level timestamps, with Whisper in the cloud (OpenAI whisper-1 on
OpenRouter, about $0.006 per minute). Used to write the exact words of a voice clip (which voice
cloning needs), to check generated speech for cut-off words, and to time every word for captions.

Needs OPENROUTER_API_KEY in the environment (src/setup/common.sh loads the project's .env).
Standard library only; as a module: transcribe(wav_bytes) -> {"text", "words": [{"word", "start", "end"}]}.

    python src/voice/transcribe.py --audio recording.wav --out recording.words.json
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

MODEL = "openai/whisper-1"


def transcribe(wav: bytes, language: str = "en") -> dict:
    """WAV bytes -> {"text": str, "words": [{"word", "start", "end"}]} (times in seconds)."""
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("Error: OPENROUTER_API_KEY is not set; put it in the project's .env")
    body = {"model": MODEL, "input_audio": {"data": base64.b64encode(wav).decode(), "format": "wav"}, "language": language,
            "response_format": "verbose_json", "timestamp_granularities": ["word"]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/audio/transcriptions", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for attempt in range(3):  # a short network hiccup should not fail a whole video
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                res = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == 2:
                sys.exit(f"Error: OpenRouter returned HTTP {e.code} for {MODEL}: {e.read().decode(errors='replace')[:400]}")
        except urllib.error.URLError as e:
            if attempt == 2:
                sys.exit(f"Error: could not reach OpenRouter: {e.reason}")
    words = [{"word": w["word"].strip(), "start": w["start"], "end": w["end"]} for w in res.get("words") or []]
    return {"text": res.get("text", "").strip(), "words": words}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="WAV file")
    ap.add_argument("--out", required=True, help="output JSON with text and word timestamps")
    ap.add_argument("--language", default="en")
    args = ap.parse_args()

    with open(args.audio, "rb") as f:
        result = transcribe(f.read(), args.language)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(result["text"])
    print(f"\n{len(result['words'])} words -> {args.out}")


if __name__ == "__main__":
    main()
