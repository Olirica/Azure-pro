"""Whisper STT server with Unix socket (local) and TCP (Railway) support.

Exposes the Whisper engine via JSON-lines protocol.
Supports two connection modes:
- Unix socket: For local development (faster, simpler)
- TCP socket: For Railway deployment (works across services)

Usage:
    whisper-svc                              # Unix socket (default)
    whisper-svc --tcp-port 8765              # TCP socket on port 8765
    WHISPER_TCP_PORT=8765 whisper-svc        # TCP via env var
"""

import asyncio
import base64
import json
import logging
import os
import signal
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .whisper_engine import WhisperEngine, pcm_to_float32
from .vad import SileroVAD
from .local_agreement import LocalAgreement
from .protocol import (
    parse_command,
    StartCommand,
    AudioCommand,
    StopCommand,
    PartialResponse,
    FinalResponse,
    ErrorResponse,
    ReadyResponse,
    WordInfo,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Configuration from environment
SOCKET_PATH = os.getenv("WHISPER_SOCKET_PATH", "/tmp/whisper-stt.sock")
TCP_HOST = os.getenv("WHISPER_TCP_HOST", "0.0.0.0")
TCP_PORT = os.getenv("WHISPER_TCP_PORT", "")  # Empty = use Unix socket


@dataclass
class Session:
    """Active STT session state."""
    session_id: str
    source_lang: str
    auto_detect_langs: list[str]
    phrase_hints: list[str]
    initial_prompt: str = ""
    agreement: LocalAgreement = field(default_factory=LocalAgreement)
    audio_buffer: bytes = b""
    is_active: bool = True
    last_activity_ms: int = 0


class WhisperServer:
    """Whisper STT server with Unix/TCP socket support."""

    def __init__(
        self,
        socket_path: str | None = None,
        tcp_host: str | None = None,
        tcp_port: int | None = None,
        model_name: str | None = None,
    ):
        self.socket_path = socket_path
        self.tcp_host = tcp_host
        self.tcp_port = tcp_port
        self.model_name = model_name or os.getenv("WHISPER_MODEL", "large-v3-turbo")

        # Determine connection mode
        self.use_tcp = tcp_port is not None

        self.engine: WhisperEngine | None = None
        self.vad: SileroVAD | None = None
        self.sessions: dict[str, Session] = {}
        self.server: asyncio.Server | None = None

        self._chunk_samples = 16000 // 4  # 250ms chunks for VAD processing
        self._min_transcribe_samples = 16000  # 1 second minimum for transcription
        self._max_transcribe_samples = 16000 * 30  # 30 second max window for transcription

    async def start(self) -> None:
        """Start the server."""
        logger.info("Initializing Whisper STT server...")

        self.engine = WhisperEngine(model_name=self.model_name)
        self.engine.load_model()

        self.vad = SileroVAD()
        self.vad.load_model()

        if self.use_tcp:
            # TCP mode for Railway
            self.server = await asyncio.start_server(
                self._handle_client,
                host=self.tcp_host,
                port=self.tcp_port,
            )
            logger.info(f"Whisper STT server listening on TCP {self.tcp_host}:{self.tcp_port}")
        else:
            # Unix socket mode for local development
            socket_file = Path(self.socket_path)
            if socket_file.exists():
                socket_file.unlink()

            self.server = await asyncio.start_unix_server(
                self._handle_client,
                path=self.socket_path,
            )

            os.chmod(self.socket_path, 0o666)
            logger.info(f"Whisper STT server listening on Unix socket {self.socket_path}")

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Handle a single client connection."""
        peer = writer.get_extra_info("peername") or "unknown"
        logger.info(f"Client connected: {peer}")

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break

                line_str = line.decode("utf-8").strip()
                if not line_str:
                    continue

                response = await self._process_command(line_str)
                if response:
                    writer.write((response + "\n").encode("utf-8"))
                    await writer.drain()

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Error handling client {peer}: {e}")
        finally:
            logger.info(f"Client disconnected: {peer}")
            writer.close()
            await writer.wait_closed()

    async def _process_command(self, line: str) -> str | None:
        """Process a command and return a response."""
        cmd = parse_command(line)

        if cmd is None:
            return ErrorResponse(
                session_id="unknown",
                error="Invalid command format",
            ).to_json()

        if isinstance(cmd, StartCommand):
            return await self._handle_start(cmd)
        elif isinstance(cmd, AudioCommand):
            return await self._handle_audio(cmd)
        elif isinstance(cmd, StopCommand):
            return await self._handle_stop(cmd)

        return None

    async def _handle_start(self, cmd: StartCommand) -> str:
        """Handle START command - create new session."""
        logger.info(f"Starting session: {cmd.session_id} (lang={cmd.source_lang})")

        agreement = LocalAgreement(
            k=int(os.getenv("WHISPER_AGREEMENT_K", "3")),
            n=int(os.getenv("WHISPER_AGREEMENT_N", "2")),
            min_new_chars=int(os.getenv("WHISPER_AGREEMENT_MIN_CHARS", "10")),
        )

        self.sessions[cmd.session_id] = Session(
            session_id=cmd.session_id,
            source_lang=cmd.source_lang,
            auto_detect_langs=cmd.auto_detect_langs,
            phrase_hints=cmd.phrase_hints,
            initial_prompt=cmd.initial_prompt or "",
            agreement=agreement,
        )

        return ReadyResponse(session_id=cmd.session_id).to_json()

    async def _handle_audio(self, cmd: AudioCommand) -> str | None:
        """Handle AUDIO command - process audio chunk."""
        session = self.sessions.get(cmd.session_id)
        if not session:
            return ErrorResponse(
                session_id=cmd.session_id,
                error="Session not found",
            ).to_json()

        if not session.is_active:
            return None

        try:
            pcm_bytes = base64.b64decode(cmd.pcm_b64)
        except Exception as e:
            return ErrorResponse(
                session_id=cmd.session_id,
                error=f"Invalid base64 audio: {e}",
            ).to_json()

        session.audio_buffer += pcm_bytes

        buffer_samples = len(session.audio_buffer) // 2

        if buffer_samples < self._min_transcribe_samples:
            return None

        # Use sliding window - only transcribe last N seconds to bound latency
        max_bytes = self._max_transcribe_samples * 2  # 2 bytes per sample
        transcribe_buffer = session.audio_buffer
        if len(transcribe_buffer) > max_bytes:
            transcribe_buffer = session.audio_buffer[-max_bytes:]

        audio = pcm_to_float32(transcribe_buffer)

        vad_events = self.vad.process_audio(audio[-self._chunk_samples:])

        is_silence = not self.vad.is_speaking and any(
            e.event_type == "speech_end" for e in vad_events
        )

        lang = None if session.source_lang == "auto" else session.source_lang.split("-")[0]

        result = self.engine.transcribe(
            audio,
            language=lang,
            initial_prompt=session.initial_prompt or None,
        )

        if is_silence:
            commit_result = session.agreement.force_commit()
            if commit_result and commit_result.text:
                session.audio_buffer = b""
                self.vad.reset()

                return FinalResponse(
                    session_id=cmd.session_id,
                    text=commit_result.text,
                    language=result.language,
                    words=[WordInfo(w.word, w.start, w.end, w.confidence)
                           for w in result.words],
                    committed_prefix=commit_result.committed_prefix,
                    tts_final=True,
                ).to_json()

        agreement_result = session.agreement.process(result.text)

        if agreement_result.is_final:
            # Trim buffer to last 5 seconds to provide context for next segment
            keep_bytes = 16000 * 5 * 2  # 5 seconds
            if len(session.audio_buffer) > keep_bytes:
                session.audio_buffer = session.audio_buffer[-keep_bytes:]

            return FinalResponse(
                session_id=cmd.session_id,
                text=agreement_result.text,
                language=result.language,
                words=[WordInfo(w.word, w.start, w.end, w.confidence)
                       for w in result.words],
                committed_prefix=agreement_result.committed_prefix,
                tts_final=False,
            ).to_json()
        else:
            return PartialResponse(
                session_id=cmd.session_id,
                text=agreement_result.text,
                language=result.language,
                confidence=result.language_confidence,
            ).to_json()

    async def _handle_stop(self, cmd: StopCommand) -> str | None:
        """Handle STOP command - end session and flush."""
        session = self.sessions.get(cmd.session_id)
        if not session:
            return None

        logger.info(f"Stopping session: {cmd.session_id}")

        response = None
        if session.audio_buffer:
            commit_result = session.agreement.force_commit()
            if commit_result and commit_result.text:
                audio = pcm_to_float32(session.audio_buffer)
                lang = None if session.source_lang == "auto" else session.source_lang.split("-")[0]
                result = self.engine.transcribe(
                    audio,
                    language=lang,
                    initial_prompt=session.initial_prompt or None,
                )

                response = FinalResponse(
                    session_id=cmd.session_id,
                    text=commit_result.text,
                    language=result.language,
                    words=[WordInfo(w.word, w.start, w.end, w.confidence)
                           for w in result.words],
                    committed_prefix=commit_result.committed_prefix,
                    tts_final=True,
                ).to_json()

        session.is_active = False
        del self.sessions[cmd.session_id]
        self.vad.reset()

        return response

    async def stop(self) -> None:
        """Stop the server."""
        logger.info("Shutting down Whisper STT server...")

        if self.server:
            self.server.close()
            await self.server.wait_closed()

        # Clean up Unix socket file if used
        if not self.use_tcp and self.socket_path:
            socket_file = Path(self.socket_path)
            if socket_file.exists():
                socket_file.unlink()

        if self.engine:
            self.engine.unload_model()

        logger.info("Server shutdown complete")


async def run_server(
    socket_path: str | None = None,
    tcp_host: str | None = None,
    tcp_port: int | None = None,
) -> None:
    """Run the server with graceful shutdown."""
    server = WhisperServer(
        socket_path=socket_path,
        tcp_host=tcp_host,
        tcp_port=tcp_port,
    )

    loop = asyncio.get_event_loop()
    shutdown_event = asyncio.Event()

    def signal_handler():
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)

    await server.start()

    await shutdown_event.wait()

    await server.stop()


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="Whisper STT server")
    parser.add_argument(
        "--socket",
        default=None,
        help=f"Unix socket path (default: {SOCKET_PATH})",
    )
    parser.add_argument(
        "--tcp-host",
        default=TCP_HOST,
        help=f"TCP host to bind (default: {TCP_HOST})",
    )
    parser.add_argument(
        "--tcp-port",
        type=int,
        default=None,
        help="TCP port (enables TCP mode, disables Unix socket)",
    )
    args = parser.parse_args()

    # Determine mode from args or environment
    tcp_port = args.tcp_port
    if tcp_port is None and TCP_PORT:
        tcp_port = int(TCP_PORT)

    socket_path = args.socket or SOCKET_PATH

    if tcp_port:
        logger.info(f"Starting in TCP mode on {args.tcp_host}:{tcp_port}")
        asyncio.run(run_server(tcp_host=args.tcp_host, tcp_port=tcp_port))
    else:
        logger.info(f"Starting in Unix socket mode at {socket_path}")
        asyncio.run(run_server(socket_path=socket_path))


if __name__ == "__main__":
    main()
