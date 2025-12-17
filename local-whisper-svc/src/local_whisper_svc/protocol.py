"""Message protocol definitions for Unix socket communication.

Protocol: JSON-lines (newline-delimited JSON)

Commands (client → server):
  START  { "cmd": "START", "session_id": "...", "source_lang": "en-US", "auto_detect_langs": [...], "phrase_hints": [...] }
  AUDIO  { "cmd": "AUDIO", "session_id": "...", "pcm_b64": "..." }  # base64-encoded PCM
  STOP   { "cmd": "STOP", "session_id": "..." }

Responses (server → client):
  PARTIAL { "type": "PARTIAL", "session_id": "...", "text": "...", "language": "en", "confidence": 0.95 }
  FINAL   { "type": "FINAL", "session_id": "...", "text": "...", "language": "en", "words": [...], "committed_prefix": "..." }
  ERROR   { "type": "ERROR", "session_id": "...", "error": "..." }
  READY   { "type": "READY", "session_id": "..." }
"""

from dataclasses import dataclass, field, asdict
from typing import Literal
import json


@dataclass
class WordInfo:
    word: str
    start: float  # seconds
    end: float    # seconds
    confidence: float = 1.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class StartCommand:
    session_id: str
    source_lang: str = "en-US"
    auto_detect_langs: list[str] = field(default_factory=list)
    phrase_hints: list[str] = field(default_factory=list)
    initial_prompt: str = ""

    def to_json(self) -> str:
        return json.dumps({
            "cmd": "START",
            "session_id": self.session_id,
            "source_lang": self.source_lang,
            "auto_detect_langs": self.auto_detect_langs,
            "phrase_hints": self.phrase_hints,
            "initial_prompt": self.initial_prompt,
        })


@dataclass
class AudioCommand:
    session_id: str
    pcm_b64: str  # base64-encoded PCM audio (16kHz, 16-bit, mono)

    def to_json(self) -> str:
        return json.dumps({
            "cmd": "AUDIO",
            "session_id": self.session_id,
            "pcm_b64": self.pcm_b64,
        })


@dataclass
class StopCommand:
    session_id: str

    def to_json(self) -> str:
        return json.dumps({
            "cmd": "STOP",
            "session_id": self.session_id,
        })


@dataclass
class PartialResponse:
    session_id: str
    text: str
    language: str
    confidence: float = 1.0

    def to_json(self) -> str:
        return json.dumps({
            "type": "PARTIAL",
            "session_id": self.session_id,
            "text": self.text,
            "language": self.language,
            "confidence": self.confidence,
        })


@dataclass
class FinalResponse:
    session_id: str
    text: str
    language: str
    words: list[WordInfo] = field(default_factory=list)
    committed_prefix: str = ""
    tts_final: bool = False

    def to_json(self) -> str:
        return json.dumps({
            "type": "FINAL",
            "session_id": self.session_id,
            "text": self.text,
            "language": self.language,
            "words": [w.to_dict() for w in self.words],
            "committed_prefix": self.committed_prefix,
            "tts_final": self.tts_final,
        })


@dataclass
class ErrorResponse:
    session_id: str
    error: str

    def to_json(self) -> str:
        return json.dumps({
            "type": "ERROR",
            "session_id": self.session_id,
            "error": self.error,
        })


@dataclass
class ReadyResponse:
    session_id: str

    def to_json(self) -> str:
        return json.dumps({
            "type": "READY",
            "session_id": self.session_id,
        })


def parse_command(line: str) -> StartCommand | AudioCommand | StopCommand | None:
    """Parse a JSON-line command from the client."""
    try:
        data = json.loads(line)
        cmd = data.get("cmd")

        if cmd == "START":
            return StartCommand(
                session_id=data["session_id"],
                source_lang=data.get("source_lang", "en-US"),
                auto_detect_langs=data.get("auto_detect_langs", []),
                phrase_hints=data.get("phrase_hints", []),
                initial_prompt=data.get("initial_prompt", ""),
            )
        elif cmd == "AUDIO":
            return AudioCommand(
                session_id=data["session_id"],
                pcm_b64=data["pcm_b64"],
            )
        elif cmd == "STOP":
            return StopCommand(session_id=data["session_id"])
        else:
            return None
    except (json.JSONDecodeError, KeyError):
        return None
