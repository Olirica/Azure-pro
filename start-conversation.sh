#!/bin/bash
# Start server with CONVERSATION profile (aggressive SDK finals)
# Override key variables from .env without editing it

echo "🚀 Starting server with CONVERSATION profile (Aggressive SDK Finals)..."
echo "   - Recognition mode: conversation"
echo "   - Strategy: Fire SDK finals on short pauses (200-300ms)"
echo "   - Fast-finals: DISABLED (unstable text causes quality issues)"
echo "   - Expected latency: ~1.5-2.5s"
echo ""

RECOGNITION_MODE=conversation \
SPEECH_STABLE_PARTIALS=3 \
SPEECH_SEGMENTATION_SILENCE_MS=300 \
SPEECH_END_SILENCE_MS=200 \
FASTFINALS_STABLE_K=99 \
FASTFINALS_MIN_STABLE_MS=9999 \
FASTFINALS_PUNCT_STABLE_MS=9999 \
FASTFINALS_MIN_CHARS=999 \
FASTFINALS_MIN_WORDS=99 \
FASTFINALS_EMIT_THROTTLE_MS=9999 \
FASTFINALS_TAIL_GUARD_CHARS=0 \
FASTFINALS_TAIL_GUARD_WORDS=0 \
SOFT_THROTTLE_MS=700 \
SOFT_MIN_DELTA_CHARS=12 \
FINAL_DEBOUNCE_MS=50 \
TRANSLATION_MERGE_ENABLED=false \
node server/index.js
