#!/bin/bash

echo "=== 30-Second Quick Test ==="
echo ""
echo "Testing:"
echo "  - Segment versioning (no repetitions)"
echo "  - Translation delivery"
echo "  - TTS playback"
echo ""

# Kill any existing servers
echo "[1/3] Ensuring port 3000 is free..."
lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill -9 2>/dev/null
sleep 1

# Start server
echo ""
echo "[2/3] Starting server..."
node server/index.js > /dev/null 2>&1 &
SERVER_PID=$!
sleep 2
echo "✓ Server running (PID: $SERVER_PID)"

# Run 30-second test
echo ""
echo "[3/3] Running 30-second test..."
npx playwright test tests/e2e-hybrid-30sec.spec.js --reporter=list

# Cleanup
echo ""
echo "Cleaning up..."
kill $SERVER_PID 2>/dev/null

exit 0
