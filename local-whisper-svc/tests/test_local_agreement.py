"""Tests for LocalAgreement commit policy."""

import pytest
from local_whisper_svc.local_agreement import LocalAgreement, AgreementResult


class TestLocalAgreement:
    """Test cases for LocalAgreement."""

    def test_initial_partials(self):
        """First N-1 transcriptions should be partial."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=10)

        result = agreement.process("Hello")
        assert result.is_final is False
        assert result.text == "Hello"

    def test_commit_on_stable_prefix(self):
        """Should commit when prefix is stable across N iterations."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=5)

        agreement.process("Hello world")
        result = agreement.process("Hello world, how are")

        assert result.is_final is True
        assert "Hello world" in result.committed_prefix

    def test_no_commit_when_prefix_unstable(self):
        """Should not commit when prefix differs between iterations."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=5)

        agreement.process("Hello world")
        result = agreement.process("Hi there world")

        assert result.is_final is False

    def test_min_new_chars_threshold(self):
        """Should not commit if new content is below min_new_chars."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=20)

        agreement.process("Hello world")
        result = agreement.process("Hello world test")

        assert result.is_final is False

    def test_force_commit(self):
        """force_commit should emit final with remaining text."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=10)

        agreement.process("Hello world this is a test")
        result = agreement.force_commit()

        assert result is not None
        assert result.is_final is True
        assert result.text == "Hello world this is a test"

    def test_force_commit_empty(self):
        """force_commit with no history should return None."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=10)

        result = agreement.force_commit()
        assert result is None

    def test_reset(self):
        """reset should clear history and committed prefix."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=5)

        agreement.process("Hello world")
        agreement.process("Hello world, how")
        agreement.reset()

        assert agreement.history == []
        assert agreement.committed_prefix == ""

    def test_history_window_size(self):
        """History should not exceed K entries."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=5)

        agreement.process("One")
        agreement.process("One two")
        agreement.process("One two three")
        agreement.process("One two three four")

        assert len(agreement.history) == 3

    def test_word_boundary_trimming(self):
        """Committed prefix should end at word boundary."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=5)

        agreement.process("Hello worl")
        result = agreement.process("Hello world is great")

        if result.is_final:
            assert not result.committed_prefix.endswith("worl")

    def test_progressive_commits(self):
        """Should make progressive commits as more stable text accumulates."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=10)

        results = []
        texts = [
            "The quick brown fox",
            "The quick brown fox jumps",
            "The quick brown fox jumps over",
            "The quick brown fox jumps over the lazy",
            "The quick brown fox jumps over the lazy dog",
        ]

        for text in texts:
            results.append(agreement.process(text))

        finals = [r for r in results if r.is_final]
        assert len(finals) >= 1

    def test_empty_string(self):
        """Should handle empty strings gracefully."""
        agreement = LocalAgreement(k=3, n=2, min_new_chars=5)

        result = agreement.process("")
        assert result.is_final is False
        assert result.text == ""


class TestLongestCommonPrefix:
    """Test the LCP helper method."""

    def test_identical_strings(self):
        """LCP of identical strings is the string itself."""
        agreement = LocalAgreement()
        lcp = agreement._longest_common_prefix(["hello", "hello", "hello"])
        assert lcp == "hello"

    def test_common_prefix(self):
        """LCP of strings with common prefix."""
        agreement = LocalAgreement()
        lcp = agreement._longest_common_prefix(["hello world", "hello there", "hello"])
        assert lcp == "hello"

    def test_no_common_prefix(self):
        """LCP of strings with no common prefix."""
        agreement = LocalAgreement()
        lcp = agreement._longest_common_prefix(["hello", "world", "test"])
        assert lcp == ""

    def test_single_string(self):
        """LCP of single string is the string."""
        agreement = LocalAgreement()
        lcp = agreement._longest_common_prefix(["hello world"])
        assert lcp == "hello world"

    def test_empty_list(self):
        """LCP of empty list is empty string."""
        agreement = LocalAgreement()
        lcp = agreement._longest_common_prefix([])
        assert lcp == ""


class TestWordBoundaryTrimming:
    """Test the word boundary trimming helper."""

    def test_trim_to_word(self):
        """Should trim to last complete word."""
        agreement = LocalAgreement()
        trimmed = agreement._trim_to_word_boundary("hello wor")
        assert trimmed == "hello"

    def test_complete_words(self):
        """Should preserve text ending with space."""
        agreement = LocalAgreement()
        trimmed = agreement._trim_to_word_boundary("hello world ")
        assert trimmed == "hello world"

    def test_single_word(self):
        """Single word without space should be preserved."""
        agreement = LocalAgreement()
        trimmed = agreement._trim_to_word_boundary("hello")
        assert trimmed == "hello"

    def test_empty_string(self):
        """Empty string should remain empty."""
        agreement = LocalAgreement()
        trimmed = agreement._trim_to_word_boundary("")
        assert trimmed == ""
