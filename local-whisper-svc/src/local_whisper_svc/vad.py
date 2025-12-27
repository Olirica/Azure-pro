"""Voice Activity Detection using Silero VAD.

Detects speech start/end events for utterance segmentation.
Used to trigger forced commits on silence and segment audio for transcription.
"""

import os
import logging
import numpy as np
from dataclasses import dataclass
from typing import Callable

import torch

logger = logging.getLogger(__name__)

# Configuration from environment
VAD_THRESHOLD = float(os.getenv("WHISPER_VAD_THRESHOLD", "0.5"))
VAD_MIN_SPEECH_MS = int(os.getenv("WHISPER_VAD_MIN_SPEECH_MS", "250"))
VAD_MIN_SILENCE_MS = int(os.getenv("WHISPER_VAD_MIN_SILENCE_MS", "300"))


@dataclass
class VADEvent:
    """Voice activity detection event."""
    event_type: str  # "speech_start", "speech_end", "speech"
    timestamp_ms: int
    confidence: float = 1.0


class SileroVAD:
    """Silero VAD wrapper for speech detection.

    Uses the Silero VAD model to detect speech segments in audio.
    Implements hysteresis to avoid rapid toggling.
    """

    def __init__(
        self,
        threshold: float = VAD_THRESHOLD,
        min_speech_ms: int = VAD_MIN_SPEECH_MS,
        min_silence_ms: int = VAD_MIN_SILENCE_MS,
        sample_rate: int = 16000,
    ):
        """Initialize the VAD.

        Args:
            threshold: Speech probability threshold (0-1)
            min_speech_ms: Minimum speech duration to trigger start
            min_silence_ms: Minimum silence duration to trigger end
            sample_rate: Audio sample rate (must be 16000 for Silero)
        """
        self.threshold = threshold
        self.min_speech_ms = min_speech_ms
        self.min_silence_ms = min_silence_ms
        self.sample_rate = sample_rate

        self.model = None
        self._is_speaking = False
        self._speech_start_ms: int | None = None
        self._silence_start_ms: int | None = None
        self._current_ms = 0

        # Callbacks
        self._on_speech_start: Callable[[int], None] | None = None
        self._on_speech_end: Callable[[int, int], None] | None = None

    def load_model(self) -> None:
        """Load the Silero VAD model."""
        if self.model is not None:
            return

        logger.info("Loading Silero VAD model")
        self.model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            force_reload=False,
            trust_repo=True,
        )
        logger.info("Silero VAD model loaded")

    def process_chunk(self, audio: np.ndarray) -> list[VADEvent]:
        """Process an audio chunk and return VAD events.

        Args:
            audio: Audio samples as float32 numpy array (16kHz, mono)

        Returns:
            List of VADEvent objects (may be empty)
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        chunk_ms = int(len(audio) / self.sample_rate * 1000)

        audio_tensor = torch.from_numpy(audio)

        speech_prob = self.model(audio_tensor, self.sample_rate).item()

        events = []
        is_speech = speech_prob >= self.threshold

        if is_speech:
            self._silence_start_ms = None

            if not self._is_speaking:
                if self._speech_start_ms is None:
                    self._speech_start_ms = self._current_ms

                speech_duration = self._current_ms - self._speech_start_ms + chunk_ms

                if speech_duration >= self.min_speech_ms:
                    self._is_speaking = True
                    events.append(VADEvent(
                        event_type="speech_start",
                        timestamp_ms=self._speech_start_ms,
                        confidence=speech_prob,
                    ))
                    if self._on_speech_start:
                        self._on_speech_start(self._speech_start_ms)

            events.append(VADEvent(
                event_type="speech",
                timestamp_ms=self._current_ms,
                confidence=speech_prob,
            ))
        else:
            self._speech_start_ms = None

            if self._is_speaking:
                if self._silence_start_ms is None:
                    self._silence_start_ms = self._current_ms

                silence_duration = self._current_ms - self._silence_start_ms + chunk_ms

                if silence_duration >= self.min_silence_ms:
                    self._is_speaking = False
                    events.append(VADEvent(
                        event_type="speech_end",
                        timestamp_ms=self._current_ms,
                        confidence=1.0 - speech_prob,
                    ))
                    if self._on_speech_end:
                        duration_ms = self._current_ms - (self._silence_start_ms - self.min_silence_ms)
                        self._on_speech_end(self._silence_start_ms, duration_ms)
                    self._silence_start_ms = None

        self._current_ms += chunk_ms
        return events

    def process_audio(self, audio: np.ndarray, chunk_ms: int = 32) -> list[VADEvent]:
        """Process full audio and return all VAD events.

        Args:
            audio: Audio samples as float32 numpy array (16kHz, mono)
            chunk_ms: Chunk size for processing (32ms recommended for Silero)

        Returns:
            List of all VADEvent objects
        """
        chunk_samples = int(self.sample_rate * chunk_ms / 1000)
        all_events = []

        for i in range(0, len(audio), chunk_samples):
            chunk = audio[i:i + chunk_samples]
            if len(chunk) < chunk_samples:
                chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))
            events = self.process_chunk(chunk)
            all_events.extend(events)

        return all_events

    def reset(self) -> None:
        """Reset VAD state for a new stream."""
        self._is_speaking = False
        self._speech_start_ms = None
        self._silence_start_ms = None
        self._current_ms = 0
        if self.model is not None:
            self.model.reset_states()

    def on_speech_start(self, callback: Callable[[int], None]) -> None:
        """Register callback for speech start events.

        Args:
            callback: Function called with timestamp_ms
        """
        self._on_speech_start = callback

    def on_speech_end(self, callback: Callable[[int, int], None]) -> None:
        """Register callback for speech end events.

        Args:
            callback: Function called with (timestamp_ms, duration_ms)
        """
        self._on_speech_end = callback

    @property
    def is_speaking(self) -> bool:
        """Check if currently detecting speech."""
        return self._is_speaking

    @property
    def is_loaded(self) -> bool:
        """Check if the model is loaded."""
        return self.model is not None
