"""LocalAgreement commit policy for streaming STT.

Tracks K consecutive transcription outputs and commits when the prefix
stabilizes across N iterations. This balances low-latency previews with
stable commits for translation.

Algorithm:
1. Maintain a sliding window of K recent transcriptions
2. Find the longest common prefix (LCP) across the last N entries
3. Commit the LCP when it has min_new_chars more than the previous commit
4. Force commit on silence (VAD end-of-speech)
"""

import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)
DEBUG_AGREEMENT = os.getenv("DEBUG_AGREEMENT", "").lower() == "true"


@dataclass
class AgreementResult:
    text: str
    is_final: bool
    committed_prefix: str = ""


class LocalAgreement:
    """LocalAgreement commit policy for streaming STT."""

    def __init__(
        self,
        k: int = 3,
        n: int = 2,
        min_new_chars: int = 10,
    ):
        """
        Args:
            k: History window size (keep last K transcriptions)
            n: Required stable iterations (check last N for agreement)
            min_new_chars: Minimum new characters before considering commit
        """
        self.k = k
        self.n = n
        self.min_new_chars = min_new_chars
        self.history: list[str] = []
        self.committed_prefix: str = ""

    def process(self, text: str) -> AgreementResult:
        """Process a new transcription and determine if it should be committed.

        Args:
            text: The latest transcription text

        Returns:
            AgreementResult with text, is_final flag, and committed_prefix
        """
        self.history.append(text)
        if len(self.history) > self.k:
            self.history.pop(0)

        if DEBUG_AGREEMENT:
            logger.info(f"[Agreement] Input: {text[:80]}...")
            logger.info(f"[Agreement] History ({len(self.history)}): {[h[:40] + '...' for h in self.history]}")

        if len(self.history) < self.n:
            return AgreementResult(
                text=text,
                is_final=False,
                committed_prefix=self.committed_prefix,
            )

        lcp = self._longest_common_prefix(self.history[-self.n:])
        lcp_trimmed = self._trim_to_word_boundary(lcp)

        if DEBUG_AGREEMENT:
            logger.info(f"[Agreement] LCP raw: {lcp[:60]}...")
            logger.info(f"[Agreement] LCP trimmed: {lcp_trimmed[:60]}...")
            logger.info(f"[Agreement] Committed: {self.committed_prefix[:40]}... (len={len(self.committed_prefix)})")

        if len(lcp_trimmed) > len(self.committed_prefix) + self.min_new_chars:
            self.committed_prefix = lcp_trimmed
            if DEBUG_AGREEMENT:
                logger.info(f"[Agreement] COMMIT: {lcp_trimmed[:60]}...")
            return AgreementResult(
                text=lcp_trimmed,
                is_final=True,
                committed_prefix=lcp_trimmed,
            )

        return AgreementResult(
            text=text,
            is_final=False,
            committed_prefix=self.committed_prefix,
        )

    def force_commit(self) -> AgreementResult | None:
        """Force commit on silence/end-of-speech.

        Returns:
            AgreementResult if there's uncommitted text, None otherwise
        """
        if not self.history:
            return None

        text = self.history[-1]

        if len(text) <= len(self.committed_prefix):
            return None

        self.committed_prefix = text
        self.history.clear()

        return AgreementResult(
            text=text,
            is_final=True,
            committed_prefix=text,
        )

    def reset(self) -> None:
        """Reset state for a new utterance."""
        self.history.clear()
        self.committed_prefix = ""

    def _longest_common_prefix(self, strings: list[str]) -> str:
        """Find the longest common prefix of a list of strings."""
        if not strings:
            return ""
        if len(strings) == 1:
            return strings[0]

        min_len = min(len(s) for s in strings)
        prefix_len = 0

        for i in range(min_len):
            char = strings[0][i]
            if all(s[i] == char for s in strings):
                prefix_len = i + 1
            else:
                break

        return strings[0][:prefix_len]

    def _trim_to_word_boundary(self, text: str) -> str:
        """Trim text to the last word boundary (space)."""
        if not text:
            return text

        last_space = text.rfind(" ")
        if last_space == -1:
            return text

        return text[:last_space + 1].rstrip()
