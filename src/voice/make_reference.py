#!/usr/bin/env python
"""Cut the voice-cloning reference clip out of a longer recording.

Takes the part between --start and --end and shortens every long pause inside it to
--max-pause seconds. The cloned voice copies the pacing of its reference, so a reference
read with one-second gaps between phrases would make the avatar speak haltingly.

Run in env/reel:
    python src/voice/make_reference.py --audio recording.wav --start 5.4 --end 24.6 \
        --out inputs/voice/voice.wav --text "exact words spoken in that part" --text-out inputs/voice/voice.txt
"""
import argparse

import numpy as np
import soundfile as sf


def silent_runs(x: np.ndarray, sr: int, threshold_db: float, min_len_s: float) -> list[tuple[int, int]]:
    """Sample ranges where the signal stays below the threshold for at least min_len_s."""
    win = int(0.02 * sr)
    pad = np.pad(np.abs(x), (0, (-len(x)) % win))
    env = pad.reshape(-1, win).max(axis=1)  # 20 ms peak envelope
    quiet = env < 10 ** (threshold_db / 20)
    runs, start = [], None
    for i, q in enumerate(np.append(quiet, False)):
        if q and start is None:
            start = i
        elif not q and start is not None:
            if (i - start) * win >= min_len_s * sr:
                runs.append((start * win, min(i * win, len(x))))
            start = None
    return runs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--text", required=True, help="exact transcript of the selected part")
    ap.add_argument("--text-out", required=True)
    ap.add_argument("--max-pause", type=float, default=0.3)
    ap.add_argument("--threshold-db", type=float, default=-27.0)
    ap.add_argument("--edge", type=float, default=0.12, help="silence kept at the start and end")
    args = ap.parse_args()

    x, sr = sf.read(args.audio, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = x[int(args.start * sr): int(args.end * sr)]

    fade = int(0.01 * sr)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    keep_each_side = int(args.max_pause * sr / 2)

    pieces, cursor, removed = [], 0, 0.0
    runs = silent_runs(x, sr, args.threshold_db, min_len_s=args.max_pause + 0.1)
    for a, b in runs:
        if a == 0 or b >= len(x):  # leading / trailing silence handled below
            continue
        cut_a, cut_b = a + keep_each_side, b - keep_each_side
        left = x[cursor:cut_a].copy()
        left[-fade:] *= ramp[::-1]
        pieces.append(left)
        cursor = cut_b
        removed += (cut_b - cut_a) / sr
    tail = x[cursor:].copy()
    pieces.append(tail)
    for p in pieces[1:]:
        p[:fade] *= ramp
    y = np.concatenate(pieces)

    # trim leading / trailing silence down to --edge seconds
    loud = np.flatnonzero(np.abs(y) > 10 ** (args.threshold_db / 20))
    edge = int(args.edge * sr)
    y = y[max(0, loud[0] - edge): min(len(y), loud[-1] + edge)]

    sf.write(args.out, y, sr, subtype="PCM_16")
    with open(args.text_out, "w", encoding="utf-8") as f:
        f.write(" ".join(args.text.split()) + "\n")
    print(f"selected {args.end - args.start:.2f} s, shortened {len(pieces) - 1} pauses "
          f"(removed {removed:.2f} s) -> {len(y) / sr:.2f} s at {sr} Hz: {args.out}")


if __name__ == "__main__":
    main()
