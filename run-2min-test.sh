#!/usr/bin/env bash
set -e

echo "=== 2-Minute Quick Pipeline Test ==="
echo ""
echo "Testing:"
echo "  - TTS deduplication (rootUnitId-based)"
echo "  - Translation delivery"
echo "  - Queue management"
echo ""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "Stopping server..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[1/3] Ensuring port 3000 is free..."
if lsof -ti :3000 >/dev/null 2>&1; then
  lsof -ti :3000 | xargs kill
  sleep 1
fi

echo ""
echo "[2/3] Starting server..."
npm start >test-2min-server.log 2>&1 &
SERVER_PID=$!
sleep 5

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "✗ Server failed to start!"
  tail -n 50 test-2min-server.log
  exit 1
fi
echo "✓ Server running (PID: $SERVER_PID)"

echo ""
echo "[3/3] Running 2-minute test..."
npx playwright test tests/e2e-hybrid-2min.spec.js --headed

TEST_EXIT_CODE=$?

echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo "✅ TEST PASSED"
  echo ""
  echo "📊 Metrics: e2e-2min-metrics.json"
  echo "📝 Server logs: test-2min-server.log"
else
  echo "❌ TEST FAILED"
  echo ""
  echo "Check: test-2min-server.log"
fi

exit $TEST_EXIT_CODE
