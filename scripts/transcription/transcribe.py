"""Reference recognizer for the transcription worker.

The worker treats recognition as an external command: it passes the path of a
16 kHz mono wav as the last argument and reads JSON from stdout. This is the
implementation that contract was written for; any program honouring it works.

Output:

    {"segments": [{"start": 0.0, "end": 1.8, "text": "..."}, ...]}

`start` and `end` are seconds from the beginning of the recording. Anything the
program writes to stderr is diagnostics only and never reaches the API.

Nothing in this repository runs or tests this file: it needs a GPU, a model
download and a Python environment none of the checks have. Install it where the
worker runs:

    pip install faster-whisper
    TRANSCRIPTION_COMMAND=python
    TRANSCRIPTION_COMMAND_ARGS=["../../scripts/transcription/transcribe.py"]

Environment:

    WHISPER_MODEL        model name or path, default "large-v3"
    WHISPER_DEVICE       "cuda" or "cpu", default "cuda"
    WHISPER_COMPUTE_TYPE precision, default "float16"
    WHISPER_LANGUAGE     forced language code; omitted means auto-detect
"""

import json
import os
import sys


def main() -> int:
    # The worker decodes this stream as UTF-8. Python otherwise encodes a
    # redirected stdout in the locale encoding, which on a Russian Windows is
    # cp1251: the JSON still parses, because its structure is ASCII, and every
    # recognized word silently becomes replacement characters in the transcript.
    sys.stdout.reconfigure(encoding="utf-8")

    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio-path>", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]

    from faster_whisper import WhisperModel

    model = WhisperModel(
        os.environ.get("WHISPER_MODEL", "large-v3"),
        device=os.environ.get("WHISPER_DEVICE", "cuda"),
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "float16"),
    )

    segments, _info = model.transcribe(
        audio_path,
        language=os.environ.get("WHISPER_LANGUAGE") or None,
        vad_filter=True,
    )

    json.dump(
        {
            "segments": [
                {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
                for segment in segments
            ]
        },
        sys.stdout,
        ensure_ascii=False,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
