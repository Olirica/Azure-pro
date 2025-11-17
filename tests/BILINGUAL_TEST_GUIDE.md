# Bilingual Audio Test Guide

This guide explains how to test the full pipeline with the bilingual audio file (`Bilingual_1min.wav`).

## Test Objectives

1. ✅ Verify audio input capture at 1:1 rate (real-time simulation)
2. ✅ Verify transcription generation
3. ✅ Verify language-specific translation (French & English)
4. ✅ Verify language switching on listener page
5. ✅ Verify pipeline works throughout entire audio file

## Prerequisites

1. **Server running**: `npm run dev`
2. **Azure credentials**: Set valid `SPEECH_KEY` and `TRANSLATOR_KEY` in `.env`
3. **Audio file**: `tests/Bilingual_1min.wav` (included)

## Option 1: Full Playwright Test (Recommended)

This test provides the most comprehensive verification:

```bash
# Install dependencies if needed
npm install

# Run the test
npx playwright test tests/e2e-bilingual-autodetect.spec.js --headed
```

### What it does:
- Launches browser with fake microphone
- Injects audio file as real-time microphone input
- Configures speaker for bilingual capture (en-US, fr-CA)
- Connects listener and captures French translations
- Switches to English and verifies translations
- Takes screenshots at each stage
- Provides detailed metrics

### Expected output:
```
BILINGUAL AUTO-DETECTION TEST RESULTS
======================================================================

Test duration: 75.2s
Speaker events captured: 15
French paragraphs received: 8
English paragraphs received: 8
Language switches: 1

✅ All assertions passed!

Verification checklist:
  ✓ Audio input captured at 1:1 rate
  ✓ Transcription generated
  ✓ French translation received
  ✓ English translation received
  ✓ Language switching works
  ✓ Pipeline active throughout entire file
```

## Option 2: MCP Playwright Server

Simpler test using the MCP server directly:

```bash
# Run the MCP test script
node tests/run-bilingual-test-mcp.mjs
```

### What it does:
- Uses the MCP Playwright server
- Injects audio as fake microphone
- Runs through entire pipeline
- Captures metrics on translations and TTS

### Expected output:
```
TEST RESULTS
======================================================================

Summary:
  Duration: 65.3s
  Translations: 12
  Fast finals: 8
  TTS events: 10

Sample translations:
  1. Bonjour, bienvenue à cette session de test...
  2. Nous allons vérifier le pipeline complet...
  ...

✅ Test completed successfully!
```

## Manual Testing Steps

If you prefer manual testing:

### 1. Create Auto-Detect Room

Via Admin page (`http://localhost:3000/admin`):
- Room ID: `bilingual-test`
- Source Language: `auto`
- Auto-detect languages: `en-US, fr-CA`
- Default target languages: `fr-CA, en-US`

### 2. Configure Speaker Page

Navigate to `http://localhost:3000/speaker?room=bilingual-test`:
- Room: `bilingual-test`
- Source language: `auto (en-US,fr-CA)` or `en-US`
- Targets: `fr-CA`
- Click "Start"

### 3. Open Listener Page

Navigate to `http://localhost:3000/listener?room=bilingual-test`:
- Should auto-connect
- Select "French" language button
- Enable TTS if desired

### 4. Play Audio Through Microphone

Use virtual audio cable or:
```bash
# macOS: Use BlackHole or Loopback
# Windows: Use VB-Cable or Voicemeeter
# Linux: Use PulseAudio loopback
```

Play `Bilingual_1min.wav` through your system audio and route to microphone.

### 5. Verify Results

**Check Speaker Page:**
- Live transcription box shows original text
- Status shows "Listening"

**Check Listener Page:**
- French translations appear
- Click "English" button
- English translations appear
- Verify smooth language switching

**Check Browser Console (F12):**
```
[Listener] Connecting to WebSocket: { room: 'bilingual-test', lang: 'fr-CA', tts: true }
[Listener] Received patch: { text: 'Bonjour...', srcLang: 'en-US', targetLang: 'fr-CA' }
```

## Troubleshooting

### No transcription appearing
- Check Azure credentials in `.env`
- Verify microphone permission granted
- Check browser console for errors
- Ensure dev server is running

### Wrong language displayed
- Check auto-connect logs: should show correct `lang` parameter
- Verify room configuration has correct `defaultTargetLangs`
- Try manual reconnect

### Audio not playing (TTS)
- Check "Enable Text-to-Speech" is checked
- On mobile: tap the "Tap to Enable Audio" overlay
- Check browser console for autoplay policy blocks
- Verify `SPEECH_KEY` is valid for TTS

### Translations in wrong language
- Check WebSocket URL in console logs
- Verify `lang` parameter matches selected language
- Check server logs for translation API calls
- Ensure `TRANSLATOR_KEY` or `OPENAI_API_KEY` is set

## Test Results Location

After running tests, check:
- **Screenshots**: `test-results/bilingual-*.png`
- **Logs**: Browser console output
- **Metrics**: JSON output in test results

## Audio File Format

The bilingual test file should be:
- **Format**: WAV (PCM)
- **Sample Rate**: 16000 Hz
- **Channels**: Mono
- **Duration**: ~60 seconds
- **Content**: Mix of English and French sentences with pauses

## Next Steps

After successful test:
1. Review screenshots in `test-results/`
2. Check metrics for pipeline latency
3. Verify TTS queue behavior
4. Test with longer audio files
5. Test with more language pairs
