"""Whisper engine wrapper for faster-whisper.

Provides streaming transcription with chunked audio processing.
Supports GPU (CUDA) with float16 for best performance, with CPU fallback.
"""

import os
import logging
import numpy as np
from dataclasses import dataclass, field
from typing import Iterator

from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# Configuration from environment
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
WHISPER_TEMPERATURE = os.getenv("WHISPER_TEMPERATURE", "0")  # "0" or "0,0.2,0.4,0.6,0.8,1.0"
WHISPER_INITIAL_PROMPT = os.getenv("WHISPER_INITIAL_PROMPT", "")  # Style hint for punctuation


@dataclass
class WordInfo:
    """Word-level timing information."""
    word: str
    start: float  # seconds
    end: float    # seconds
    confidence: float = 1.0


@dataclass
class TranscriptionResult:
    """Result of a transcription operation."""
    text: str
    language: str
    language_confidence: float = 1.0
    words: list[WordInfo] = field(default_factory=list)
    duration_seconds: float = 0.0


class WhisperEngine:
    """Wrapper for faster-whisper with streaming support.

    Designed for real-time transcription with:
    - GPU acceleration (float16 on CUDA)
    - CPU fallback for development/CI
    - Word-level timestamps
    - Language detection
    """

    def __init__(
        self,
        model_name: str = WHISPER_MODEL,
        device: str = WHISPER_DEVICE,
        compute_type: str = WHISPER_COMPUTE_TYPE,
    ):
        """Initialize the Whisper engine.

        Args:
            model_name: Whisper model to use (e.g., "large-v3-turbo")
            device: Device to use ("cuda" or "cpu")
            compute_type: Compute type ("float16", "int8", "float32")
        """
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.model: WhisperModel | None = None
        self._sample_rate = 16000  # Whisper expects 16kHz audio

    def load_model(self) -> None:
        """Load the Whisper model. Call this before transcribe()."""
        if self.model is not None:
            logger.warning("Model already loaded, skipping")
            return

        logger.info(
            f"Loading Whisper model: {self.model_name} "
            f"(device={self.device}, compute_type={self.compute_type})"
        )

        try:
            self.model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
            logger.info(
                f"Whisper model loaded: beam_size={WHISPER_BEAM_SIZE}, "
                f"temperature={WHISPER_TEMPERATURE}"
            )
        except Exception as e:
            if self.device == "cuda":
                logger.warning(f"CUDA load failed: {e}, falling back to CPU")
                self.device = "cpu"
                self.compute_type = "int8"
                self.model = WhisperModel(
                    self.model_name,
                    device="cpu",
                    compute_type="int8",
                )
                logger.info("Whisper model loaded on CPU (fallback)")
            else:
                raise

    def transcribe(
        self,
        audio: np.ndarray,
        language: str | None = None,
        initial_prompt: str | None = None,
    ) -> TranscriptionResult:
        """Transcribe audio data.

        Args:
            audio: Audio samples as float32 numpy array (16kHz, mono)
            language: Source language code (e.g., "en", "fr") or None for auto-detect
            initial_prompt: Optional prompt to guide transcription

        Returns:
            TranscriptionResult with text, language, and word timings
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        if audio.max() > 1.0 or audio.min() < -1.0:
            audio = audio / 32768.0

        duration_seconds = len(audio) / self._sample_rate

        # Use env prompt if no explicit prompt provided
        prompt = initial_prompt if initial_prompt else (WHISPER_INITIAL_PROMPT or None)

        # Parse temperature: single value or comma-separated fallback list
        temp_str = WHISPER_TEMPERATURE
        if "," in temp_str:
            temperature = [float(t.strip()) for t in temp_str.split(",")]
        else:
            temperature = float(temp_str)

        segments, info = self.model.transcribe(
            audio,
            language=language,
            initial_prompt=prompt,
            word_timestamps=True,
            vad_filter=False,  # We handle VAD separately
            condition_on_previous_text=True,
            beam_size=WHISPER_BEAM_SIZE,
            temperature=temperature,
        )

        segments_list = list(segments)

        text_parts = []
        words = []

        for segment in segments_list:
            text_parts.append(segment.text)
            if segment.words:
                for w in segment.words:
                    words.append(WordInfo(
                        word=w.word,
                        start=w.start,
                        end=w.end,
                        confidence=w.probability,
                    ))

        return TranscriptionResult(
            text=" ".join(text_parts).strip(),
            language=info.language,
            language_confidence=info.language_probability,
            words=words,
            duration_seconds=duration_seconds,
        )

    def transcribe_streaming(
        self,
        audio: np.ndarray,
        chunk_duration_ms: int = 400,
        overlap_ms: int = 100,
        language: str | None = None,
    ) -> Iterator[TranscriptionResult]:
        """Transcribe audio in streaming chunks.

        Yields partial results as audio is processed in chunks.
        Useful for real-time applications.

        Args:
            audio: Audio samples as float32 numpy array (16kHz, mono)
            chunk_duration_ms: Duration of each chunk in milliseconds
            overlap_ms: Overlap between chunks in milliseconds
            language: Source language code or None for auto-detect

        Yields:
            TranscriptionResult for each chunk
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        chunk_samples = int(self._sample_rate * chunk_duration_ms / 1000)
        overlap_samples = int(self._sample_rate * overlap_ms / 1000)
        step_samples = chunk_samples - overlap_samples

        audio_len = len(audio)
        offset = 0
        accumulated_text = ""

        while offset < audio_len:
            end = min(offset + chunk_samples, audio_len)
            chunk = audio[offset:end]

            if len(chunk) < chunk_samples // 2:
                break

            result = self.transcribe(chunk, language=language)

            chunk_start_sec = offset / self._sample_rate
            for word in result.words:
                word.start += chunk_start_sec
                word.end += chunk_start_sec

            accumulated_text = self._merge_text(accumulated_text, result.text)
            result.text = accumulated_text

            yield result

            offset += step_samples

    def _merge_text(self, prev: str, new: str) -> str:
        """Merge overlapping text from consecutive chunks."""
        if not prev:
            return new
        if not new:
            return prev

        prev_words = prev.split()
        new_words = new.split()

        for overlap_len in range(min(5, len(prev_words)), 0, -1):
            if prev_words[-overlap_len:] == new_words[:overlap_len]:
                return prev + " " + " ".join(new_words[overlap_len:])

        return prev + " " + new

    def unload_model(self) -> None:
        """Unload the model to free memory."""
        if self.model is not None:
            del self.model
            self.model = None
            logger.info("Whisper model unloaded")

    @property
    def is_loaded(self) -> bool:
        """Check if the model is loaded."""
        return self.model is not None


def pcm_to_float32(pcm_bytes: bytes) -> np.ndarray:
    """Convert PCM bytes (16-bit signed, little-endian) to float32 numpy array.

    Args:
        pcm_bytes: Raw PCM audio bytes (16kHz, 16-bit, mono)

    Returns:
        Float32 numpy array normalized to [-1, 1]
    """
    int16_audio = np.frombuffer(pcm_bytes, dtype=np.int16)
    float32_audio = int16_audio.astype(np.float32) / 32768.0
    return float32_audio
