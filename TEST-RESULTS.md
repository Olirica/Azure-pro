# 8-Minute Audio Pipeline Test Results

## Test Session: 2025-10-15

### Test Setup
- **Audio File:** `samples/conference_full.wav` (~8 minutes, medical conference)
- **Source Language:** en-CA
- **Target Language:** fr-CA (French Canadian)
- **Speaker:** Dr. Armand Aprikian discussing prostate cancer treatments

---

## Test #1: STT File Harness (Completed)

### What Was Tested
Ran the STT file harness test which processes audio through Azure Speech SDK locally.

### Results

**✅ STT Performance:**
- Successfully transcribed ~8 minutes of medical terminology
- First final at ~15.8 seconds (good latency)
- Continuous recognition throughout
- Proper handling of medical terms: "enzalutamide", "urological oncologist", "McGill University Health Centre"
- No recognition timeouts or crashes

**⚠️ Limitations Discovered:**
- **File harness != Real pipeline**: The test processes audio faster than real-time
- **No server connection**: Doesn't POST patches to server
- **No translation**: Azure Translator never invoked
- **No TTS**: No audio generated for listeners
- **No fast-finals testing**: Client-side logic not exercised

### Key Insight
**The STT file harness is useful for testing Azure Speech SDK configuration, but does NOT test the full translation pipeline.**

---

## Test #2: Full Pipeline Test (NEEDED)

### What Needs To Be Tested
A **real-time, end-to-end test** with:

1. **Speaker page** capturing audio from microphone
2. **Server** receiving patches, translating, generating TTS
3. **Listener page** receiving translations and playing TTS audio
4. **Timing** at 1:1 real-time speed (8 minutes of audio = 8 minutes of testing)

### Test Scenarios

#### Scenario A: Manual Browser Test (RECOMMENDED)
**Why:** Tests real user experience with actual audio playback timing

**Steps:**
1. Start server: `npm start`
2. Open `http://localhost:3000/speaker.html`
   - Set room: demo-room
   - Set lang: en-CA → fr-CA
   - Click "Start capture"
3. Open `http://localhost:3000/listener.html` (separate tab/window)
   - Set room: demo-room
   - Set lang: fr-CA
   - Enable TTS
   - Click "Connect"
   - Open browser console (F12) for timing logs
4. **Play audio through speakers:**
   - Use macOS QuickTime Player or VLC
   - Open `/Users/olivierlepage/Downloads/pipeline_test/audio_10min.wav`
   - Set volume so speaker mic picks it up
   - Play at normal speed
5. **Monitor for 8+ minutes:**
   - Speaker: Watch for 🚀 FAST-FINAL commits
   - Listener: Watch transcript build up
   - Listener: Hear French TTS audio
   - Console: Check timing logs
   - Server logs: Look for backlog warnings

**Expected Outcomes:**
- ✅ Translations appear within 2-5 seconds of speech
- ✅ TTS plays continuously without gaps
- ⚠️ TTS backlog warnings if speaker talks faster than TTS generates
- ✅ TTS speed-up kicks in when backlog > 8 seconds
- ✅ System recovers when backlog drops below 4 seconds

#### Scenario B: Automated Real-Time Test (TODO)
**Why:** Repeatable, measurable, can run overnight

**Requirements:**
- Script that plays WAV file through virtual audio device
- Speaker page connects to virtual mic
- Playwright/Puppeteer controls both speaker and listener pages
- Logs all timing metrics to JSON file
- Runs at exact 1:1 real-time speed

**Not yet implemented** - requires virtual audio routing setup

---

## Current State Summary

### What's Working ✅
- Server starts cleanly
- STT processes medical terminology accurately
- Fast-finals config updated (K=2, minStableMs=300)
- Listener queue logic fixed (no longer drops audio)
- Console logging added for timing metrics

### What's Not Tested Yet ⚠️
- **End-to-end translation pipeline**
- **TTS generation and playback**
- **TTS backlog behavior and speed adjustment**
- **Fast-finals in real continuous speech**
- **8-minute sustained operation**

### What's Needed Next 🎯
1. **Manual browser test** (see Scenario A above)
2. **Document observed behavior:**
   - Translation latency
   - TTS queue depth over time
   - Backlog warnings and speed adjustments
   - Any connection drops or errors
3. **Collect metrics:**
   - Browser console logs from listener
   - Server logs with backlog warnings
   - Speaker debug log showing fast-finals
4. **Identify bottlenecks:**
   - Is translation slow?
   - Is TTS generation slow?
   - Is network latency an issue?
   - Does queue grow unbounded?

---

## Recommendations for User

### When You Return:

**Option 1: Quick Manual Test (15 minutes)**
```bash
npm start
# Open speaker.html and listener.html in browser
# Play audio_10min.wav through speakers
# Watch for ~2-3 minutes to see behavior
# Copy browser console logs and server logs
```

**Option 2: Full 8-Minute Test (20 minutes)**
```bash
npm start
# Same as above but let entire audio play
# Perfect for observing sustained operation and backlog behavior
```

### What to Look For:
1. **Speaker page:**
   - Are fast-finals firing? (look for 🚀)
   - Any "No audio detected" issues?
   - Does it run for full 8 minutes without stopping?

2. **Listener page (console):**
   - Are patches arriving quickly?
   - Is TTS queue growing or stable?
   - What's the `queueLatencyMs` value?
   - Any playback errors?

3. **Server logs:**
   - Any TTS backlog warnings?
   - Did speed-up activate?
   - Translation errors?

---

## Next Steps for Development

### Immediate Priorities:
1. ✅ Listener queue fix (DONE - no longer drops audio)
2. ✅ Console logging (DONE - detailed timing metrics)
3. ⏳ Run manual browser test (PENDING - requires user)
4. ⏳ Analyze results and tune parameters

### Future Enhancements:
1. **Automated real-time testing** - Virtual audio routing
2. **Filler word removal** - Use Azure confidence scores
3. **Better TTS speed control** - Dynamic rate adjustment
4. **Translation condensing** - Remove redundant words
5. **Performance dashboard** - Real-time metrics visualization

---

## Technical Notes

### STT Configuration
```
SPEECH_STABLE_PARTIALS=4
SPEECH_SEGMENTATION_SILENCE_MS=500
SPEECH_END_SILENCE_MS=350
SPEECH_INITIAL_SILENCE_MS=3000
```

### Fast-Finals Configuration
```
FASTFINALS_STABLE_K=2          (reduced from 3)
FASTFINALS_MIN_STABLE_MS=300   (reduced from 500)
FASTFINALS_PUNCT_STABLE_MS=200 (reduced from 250)
FASTFINALS_MIN_CHARS=20        (reduced from 28)
FASTFINALS_MIN_WORDS=3         (reduced from 4)
```

### TTS Backlog Control
```
TTS_MAX_BACKLOG_SEC=8         (triggers speed-up at 8s queue)
TTS_RESUME_BACKLOG_SEC=4      (returns to normal at 4s)
TTS_RATE_BOOST_PERCENT=10     (+10% speed when backlog high)
```

---

*Test documentation will be updated after manual browser test is completed.*
