#!/usr/bin/env bash
set -e

echo "=== 8-Minute Audio Pipeline Test ==="
echo ""
echo "This test will:"
echo "  1. Start the server"
echo "  2. Process 8 minutes of audio through STT"
echo "  3. Monitor translation and TTS throughout"
echo "  4. Check for backlog warnings and catch-up behavior"
echo ""

# Cleanup function
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo ""
    echo "Stopping server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Step 1: Ensure port is free
echo "[1/4] Ensuring port 3000 is free..."
if lsof -ti :3000 >/dev/null 2>&1; then
  echo "  → Killing existing process on port 3000"
  lsof -ti :3000 | xargs kill
  sleep 1
fi

# Step 2: Start server
echo ""
echo "[2/4] Starting server..."
npm start >server-8min-test.log 2>&1 &
SERVER_PID=$!
echo "  → Server PID: $SERVER_PID"
echo "  → Waiting 4 seconds for server to boot..."
sleep 4

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "  ✗ Server failed to start! Showing logs:"
  tail -n 50 server-8min-test.log
  exit 1
fi
echo "  ✓ Server is running"

# Step 3: Instructions for manual testing
echo ""
echo "[3/4] Ready for testing!"
echo ""
echo "📋 Test Instructions:"
echo ""
echo "1. Open SPEAKER page: http://localhost:3000/speaker.html"
echo "   - Room: demo-room"
echo "   - Source lang: en-CA"
echo "   - Target lang: fr-CA"
echo "   - Click 'Start capture'"
echo ""
echo "2. Open LISTENER page in another tab: http://localhost:3000/listener.html"
echo "   - Room: demo-room"
echo "   - Language: fr-CA"
echo "   - Enable TTS: checked"
echo "   - Click 'Connect'"
echo "   - Open browser console (F12) to see timing logs"
echo ""
echo "3. PLAY the 8-minute audio file:"
echo "   - Open: /Users/olivierlepage/Downloads/pipeline_test/audio_10min.wav"
echo "   - Play it through your speakers (so speaker page mic captures it)"
echo "   - NOTE: First 29 seconds are silent/music"
echo ""
echo "4. Watch for:"
echo "   - ✅ Speaker: Fast-finals firing (🚀 FAST-FINAL messages)"
echo "   - ✅ Speaker: Continuous recognition (no gaps/timeouts)"
echo "   - ✅ Listener: Translations appearing quickly"
echo "   - ✅ Listener: TTS audio playing"
echo "   - ⚠️  Server logs: TTS backlog warnings"
echo "   - ✅ Server logs: TTS speed-up applied when backlog high"
echo ""
echo "[4/4] Server logs will be tailed below..."
echo "      Press Ctrl+C when test is complete."
echo ""
echo "================================================================"
echo ""

# Step 4: Tail server logs
tail -f server-8min-test.log
