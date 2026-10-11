#!/usr/bin/env python3
"""transcribe.py — one audio file in, a transcript beside it out.

    transcribe.py <audio> <model> <outbase>

Writes <outbase>.whisper.json (segments with times) and <outbase>.txt (plain
text), and prints a one-line JSON summary on stdout for the caller.

faster-whisper decodes the file itself through PyAV (webm/opus, mp4/aac, wav,
aiff …), so no ffmpeg binary is needed — which keeps the Pi5 install to one
pip package. int8 on the CPU: the Pi has no GPU and int8 is the fast path there.
Trimmed from the whisper-transcribe skill's scripts/transcribe.py.
"""
import json
import sys
import time

from faster_whisper import WhisperModel


def main():
    audio, model_name, outbase = sys.argv[1:4]
    started = time.time()
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, beam_size=1, vad_filter=True)
    segs = [
        {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
        for s in segments
    ]
    text = " ".join(s["text"] for s in segs).strip()
    elapsed = round(time.time() - started, 2)
    record = {
        "provider": "faster-whisper",
        "model": model_name,
        "language": info.language,
        "duration": round(info.duration, 2),
        "elapsed": elapsed,
        "text": text,
        "segments": segs,
    }
    with open(f"{outbase}.whisper.json", "w") as f:
        json.dump(record, f, indent=1, ensure_ascii=False)
    with open(f"{outbase}.txt", "w") as f:
        f.write(text + "\n")
    print(json.dumps({k: record[k] for k in ("model", "language", "duration", "elapsed")}))


if __name__ == "__main__":
    main()
