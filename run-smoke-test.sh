#!/usr/bin/env bash
set -e  # Exit on error

# Cleanup function to ensure server is stopped
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo ""
    echo "Cleaning up server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== WebSocket Smoke Test Runner ==="
echo ""

# Step 1: Ensure the port is free
echo "[1/5] Ensuring port 3000 is free..."
if lsof -ti :3000 >/dev/null 2>&1; then
  echo "  → Killing existing process on port 3000"
  lsof -ti :3000 | xargs kill
  sleep 1
else
  echo "  → Port 3000 is already free"
fi

# Step 2: Start the server in the background with verbose WS logging
echo ""
echo "[2/5] Starting server with verbose WS logging..."
WS_VERBOSE_LOG=true npm start >server.log 2>&1 &
SERVER_PID=$!
echo "  → Server PID: $SERVER_PID"
echo "  → Waiting 4 seconds for server to boot..."
sleep 4

# Verify server is still running
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "  ✗ Server failed to start! Showing logs:"
  tail -n 50 server.log
  exit 1
fi
echo "  ✓ Server is running"

# Step 3: Copy the root .env to pipeline-bench
echo ""
echo "[3/5] Copying .env to tests/pipeline-bench/..."
cp .env tests/pipeline-bench/.env
echo "  ✓ Environment configured"

# Step 4: Run the WebSocket smoke test with a deadline
echo ""
echo "[4/5] Running WebSocket smoke test (30s timeout)..."
cd tests/pipeline-bench

# Temporarily disable exit-on-error to capture test result
set +e

# Run with timeout using Perl (works on macOS and Linux)
perl -e 'alarm shift @ARGV; exec @ARGV' 30 node tests/30_pipeline_smoke.js \
  --server ws://localhost:3000/ws \
  --room demo-room \
  --speaker demo2025-speaker \
  --listener demo2025 \
  --lang fr-CA

TEST_RC=$?
set -e  # Re-enable exit-on-error
cd ../..

# Step 5: Collect logs
echo ""
echo "[5/5] Collecting logs..."
echo ""
echo "=== Last 200 lines of server.log ==="
tail -n 200 server.log
echo ""
echo "=== End of logs ==="

# Report test result
echo ""
if [ $TEST_RC -eq 0 ]; then
  echo "✓ Smoke test PASSED"
  exit 0
elif [ $TEST_RC -eq 124 ]; then
  echo "✗ Smoke test TIMED OUT after 30s"
  exit 124
else
  echo "✗ Smoke test FAILED with exit code $TEST_RC"
  exit $TEST_RC
fi
