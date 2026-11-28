#!/usr/bin/env python
"""Transcribe a recording with word-level timestamps, with Whisper in the cloud (OpenAI whisper-1 on
OpenRouter, about $0.006 per minute). Used to write the exact words of a voice clip (which voice
cloning needs), to check generated speech for cut-off words, and to time every word for captions.

Needs OPENROUTER_API_KEY, from the environment or the project's .env.
Standard library only; as a module: transcribe(wav_bytes) -> {"text", "words": [{"word", "start", "end"}]}.

    python src/reel/transcribe.py --audio recording.wav --out recording.words.json [--text-out recording.txt]
"""
import argparse
import base64
import json

from api import need_key, request

MODEL = "openai/whisper-1"


def transcribe(wav: bytes, language: str = "en") -> dict:
    """WAV bytes -> {"text": str, "words": [{"word", "start", "end"}]} (times in seconds)."""
    body = {"model": MODEL, "input_audio": {"data": base64.b64encode(wav).decode(), "format": "wav"}, "language": language,
            "response_format": "verbose_json", "timestamp_granularities": ["word"]}
    res = json.loads(request("https://openrouter.ai/api/v1/audio/transcriptions", body,
                             {"Authorization": f"Bearer {need_key('OPENROUTER_API_KEY')}"}, name=f"OpenRouter ({MODEL})",
                             retries=2))  # a short network hiccup should not fail a whole video
    words = [{"word": w["word"].strip(), "start": w["start"], "end": w["end"]} for w in res.get("words") or []]
    return {"text": res.get("text", "").strip(), "words": words}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="WAV file")
    ap.add_argument("--out", required=True, help="output JSON with text and word timestamps")
    ap.add_argument("--text-out", help="also write the text alone to this file")
    ap.add_argument("--language", default="en")
    args = ap.parse_args()

    with open(args.audio, "rb") as f:
        result = transcribe(f.read(), args.language)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    if args.text_out:
        with open(args.text_out, "w", encoding="utf-8") as f:
            f.write(result["text"].strip() + "\n")
    print(result["text"])
    print(f"\n{len(result['words'])} words -> {args.out}")


if __name__ == "__main__":
    main()
