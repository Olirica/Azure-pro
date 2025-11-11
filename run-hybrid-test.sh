#!/usr/bin/env bash
set -e

echo "=== Hybrid E2E Pipeline Test ==="
echo ""
echo "This automated test will:"
echo "  - Start the server"
echo "  - Process audio with Azure STT (real-time chunks)"
echo "  - POST recognition results to server"
echo "  - Open listener page in headless Chrome"
echo "  - Collect metrics on translation and TTS"
echo "  - Generate a detailed report"
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
npm start >e2e-hybrid-server.log 2>&1 &
SERVER_PID=$!
echo "  → Server PID: $SERVER_PID"
echo "  → Waiting 5 seconds for server to boot..."
sleep 5

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "  ✗ Server failed to start! Showing logs:"
  tail -n 50 e2e-hybrid-server.log
  exit 1
fi
echo "  ✓ Server is running"

# Step 3: Run Playwright hybrid test
echo ""
echo "[3/4] Running Playwright hybrid test..."
echo "  → This will take ~8-9 minutes (real-time audio processing)"
echo "  → Watch for STT events and listener metrics"
echo ""
npx playwright test tests/e2e-hybrid-realtime.spec.js --headed

TEST_EXIT_CODE=$?

# Step 4: Show results
echo ""
echo "[4/4] Test completed!"
echo ""

if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo "✅ TEST PASSED"
  echo ""
  echo "📊 Metrics saved to: e2e-hybrid-metrics.json"
  echo "📄 HTML report: playwright-report/index.html"
  echo "📝 Server logs: e2e-hybrid-server.log"
  echo ""
  echo "To view the HTML report:"
  echo "  npx playwright show-report"
  echo ""
  exit 0
else
  echo "❌ TEST FAILED (exit code: $TEST_EXIT_CODE)"
  echo ""
  echo "Check logs:"
  echo "  - e2e-hybrid-server.log (server logs)"
  echo "  - playwright-report/index.html (test report)"
  echo ""
  exit $TEST_EXIT_CODE
fi
