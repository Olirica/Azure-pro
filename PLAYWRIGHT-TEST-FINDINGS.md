# Playwright E2E Test - Findings and Limitations

## Date: 2025-10-15

---

## What Was Attempted

Created a Playwright-based E2E test (`tests/e2e-realtime-pipeline.spec.js`) to automatically test the full 8-minute conference pipeline with real-time audio streaming.

**Goal:** Simulate a real speaker→server→listener flow with metrics collection

**Approach:** Inject fake microphone using Web Audio API's `MediaStreamAudioDestinationNode`

---

## Test Failure: Root Cause

### The Problem

The Azure Speech SDK **does not use `navigator.mediaDevices.getUserMedia()`** for microphone capture. Instead, it uses its own internal audio capture mechanism that bypasses the browser's media APIs.

### Evidence

1. **Server logs showed watchdog timeouts:**
   ```
   {"level":40,"time":1760573383977,"roomId":"e2e-test-room",
    "component":"watchdog","idleEventMs":15000,"idlePcmMs":7000,
    "eventIdleMs":18207,"pcmIdleMs":18207,
    "msg":"Watchdog conditions met, signalling restart."}
   ```
   - Server never received PCM audio data
   - No STT events triggered

2. **Speaker page showed "LISTENING" but no transcription:**
   - Fake microphone created MediaStream successfully
   - Azure SDK didn't consume the stream
   - No recognition events fired

3. **Code inspection confirms:**
   ```javascript
   // speaker.html line 847
   const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
   ```
   - Azure SDK uses `fromDefaultMicrophoneInput()` which accesses the **actual hardware microphone**
   - It doesn't use `getUserMedia()` MediaStreams

### Why Fake Microphone Didn't Work

```javascript
// Our Playwright injection:
navigator.mediaDevices.getUserMedia = async function(constraints) {
  // Return fake MediaStream from WAV file...
  return destination.stream;
};
```

**But Azure SDK never calls `getUserMedia()`!**

It uses its own Web Audio capture or native bindings that bypass this API entirely.

---

## Alternative Approaches Considered

### Option 1: Push Stream API ❌
The file harness test (`10_stt_file_harness.js`) uses:
```javascript
const pushStream = sdk.AudioInputStream.createPushStream(...);
pushStream.write(audioData); // Sends ALL data at once
```

**Problem:** This sends audio faster than real-time, can't test TTS backlog behavior.

### Option 2: Modify speaker.html to Accept File Input ❌
Add a file upload button that feeds audio via `AudioConfig.fromWavFileInput()`.

**Problem:**
- Requires modifying production code for testing
- `fromWavFileInput()` also processes faster than real-time
- Not a true E2E test of the microphone capture flow

### Option 3: Virtual Audio Device (BlackHole) + Manual Test ✅
Use macOS virtual audio device to route audio file → browser microphone.

**Problem:**
- Requires manual setup (install BlackHole)
- Not fully automated
- **But this is the ONLY way to test the full pipeline at real-time speed**

---

## Recommended Approach: Manual Browser Test

The **manual browser test documented in TEST-RESULTS.md** is currently the best way to test the full pipeline:

1. Start server
2. Open speaker page in browser
3. Open listener page in separate browser
4. Play audio file through speakers
5. MacBook mic captures audio in real-time
6. Observe metrics in console logs

**Why this works:**
- Real microphone capture (what Azure SDK expects)
- Real-time audio processing (1:1 speed ratio)
- Full pipeline tested: STT → Translation → TTS
- Console logs provide all metrics

**Limitations:**
- Requires manual execution
- Not repeatable (ambient noise, volume variations)
- Takes full 8 minutes each run

---

## Playwright Test Outcome

**Test Status:** ❌ **FAILED** (as expected)

**Results:**
```
Total test duration: 512.4 seconds (8.5 minutes)
Fast-finals emitted: 0
Translations received: 0
TTS queue events: 0
```

**Assertion failures:**
```
expect(metrics.translations.length).toBeGreaterThan(0);
Expected: > 0
Received: 0
```

**Why it failed:**
- Fake microphone didn't feed audio to Azure Speech SDK
- No STT → no translations → no TTS
- Test ran for full duration but processed nothing

---

## What We Learned

1. **Azure Speech SDK audio capture is opaque**
   - Doesn't use standard Web APIs
   - Can't be mocked or stubbed in browser
   - Requires real microphone or native audio routing

2. **Playwright limitations for Azure SDK**
   - Can control browser APIs (`getUserMedia`, etc.)
   - Cannot control native Azure SDK internals
   - Cannot inject audio into `fromDefaultMicrophoneInput()`

3. **Real-time testing requires real audio routing**
   - Virtual audio devices (BlackHole, VB-Cable)
   - Physical microphone capture
   - Or server-side push stream modifications

---

## Next Steps

### Immediate: Manual Browser Test
Follow the documented manual test procedure:

```bash
# Terminal 1: Start server
npm start

# Browser 1: Speaker page
open http://localhost:3000/speaker.html
# Room: demo-room
# Lang: en-CA → fr-CA
# Click "Start capture"

# Browser 2: Listener page (OPEN CONSOLE F12!)
open http://localhost:3000/listener.html
# Room: demo-room
# Lang: fr-CA
# Enable TTS
# Click "Connect"

# Terminal 2: Play audio through speakers
open -a "QuickTime Player" /Users/olivierlepage/code/azure-pro/tests/pipeline-bench/samples/conference_full.wav
# Adjust volume so mic captures audio
# Let it run for 8 minutes
```

### Future: Automated Testing Options

1. **Virtual Audio Device Setup**
   - Install BlackHole (macOS) or VB-Cable (Windows)
   - Route file playback → virtual device → browser mic
   - Playwright controls browser, audio routes through system
   - **Complexity:** Medium, requires system setup

2. **Server-Side Real-Time Push Stream**
   - Create server endpoint that accepts audio file
   - Stream chunks with real-time delays
   - Server POSTs patches as if from speaker page
   - **Complexity:** High, requires server modifications

3. **Hybrid: File Harness + HTTP POST**
   - Modify `10_stt_file_harness.js` to POST results to server
   - Throttle POSTs to match real-time speed
   - Tests translation + TTS but not STT
   - **Complexity:** Medium, partial coverage

---

## Files Created

1. `/Users/olivierlepage/code/azure-pro/tests/e2e-realtime-pipeline.spec.js`
   - Playwright test with fake microphone (didn't work)
   - Good template for future tests if SDK allows mocking

2. `/Users/olivierlepage/code/azure-pro/playwright.config.js`
   - Playwright configuration
   - Auto-grants microphone permissions

3. `/Users/olivierlepage/code/azure-pro/run-e2e-realtime-test.sh`
   - Test runner script
   - Server management

4. `/Users/olivierlepage/code/azure-pro/PLAYWRIGHT-TEST-FINDINGS.md`
   - This document

---

## Conclusion

**Automated real-time E2E testing with Playwright is not feasible** due to Azure Speech SDK's opaque audio capture mechanism.

**Recommended path forward:**
1. Use **manual browser test** for full pipeline validation
2. Use **file harness test** for STT-only validation (fast, automated)
3. Consider **virtual audio device** setup for semi-automated testing in the future

The Playwright test infrastructure created can be repurposed if:
- Azure SDK adds push stream support in browser
- We switch to a different STT provider that uses `getUserMedia()`
- We create a test-specific speaker page variant

---

**Bottom line:** The manual browser test documented in TEST-RESULTS.md remains the best way to test the full 8-minute pipeline until we invest in virtual audio device infrastructure.
