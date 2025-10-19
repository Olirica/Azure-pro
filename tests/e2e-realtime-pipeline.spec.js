/**
 * End-to-End Real-Time Pipeline Test
 *
 * This test simulates a real conference scenario:
 * - Speaker page captures audio from microphone (simulated with fake media stream)
 * - Audio is processed at real-time speed (8 minutes = 8 minutes of test time)
 * - Server translates and generates TTS
 * - Listener receives translations and TTS audio
 *
 * Metrics collected:
 * - Translation latency
 * - TTS queue depth over time
 * - Backlog warnings
 * - Fast-finals frequency
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_URL = 'http://localhost:3000';
const ROOM_ID = 'e2e-test-room';
const AUDIO_FILE = '/Users/olivierlepage/code/azure-pro/tests/pipeline-bench/samples/conference_full.wav';

// Test timeout: 10 minutes (audio is ~8 min)
test.setTimeout(600000);

test.describe('Real-Time Translation Pipeline', () => {

  test('8-minute conference audio with real-time playback', async ({ browser }) => {

    // Create two browser contexts: speaker and listener
    const speakerContext = await browser.newContext({
      permissions: ['microphone'],
      // Grant autoplay for media
      bypassCSP: true
    });

    const listenerContext = await browser.newContext({
      permissions: [],
      bypassCSP: true
    });

    const speakerPage = await speakerContext.newPage();
    const listenerPage = await listenerContext.newPage();

    // Metrics collection
    const metrics = {
      speakerEvents: [],
      listenerEvents: [],
      fastFinals: [],
      ttsQueue: [],
      translations: [],
      errors: []
    };

    // ===================================================================
    // SPEAKER PAGE SETUP
    // ===================================================================

    console.log('[Test] Setting up speaker page...');

    // Intercept speaker console logs
    speakerPage.on('console', msg => {
      const text = msg.text();
      const timestamp = Date.now();

      if (text.includes('🚀 FAST-FINAL')) {
        const match = text.match(/segment":"([^"]+)"/);
        if (match) {
          metrics.fastFinals.push({
            timestamp,
            segment: match[1],
            text
          });
          console.log(`[Speaker] FAST-FINAL: ${match[1].substring(0, 40)}...`);
        }
      }

      if (text.includes('Prefix committed')) {
        metrics.speakerEvents.push({ timestamp, type: 'prefix-commit', text });
      }

      if (text.includes('Recognized (final)')) {
        metrics.speakerEvents.push({ timestamp, type: 'final', text });
      }
    });

    await speakerPage.goto(`${SERVER_URL}/speaker.html`);

    // Configure speaker
    await speakerPage.fill('#roomId', ROOM_ID);
    await speakerPage.fill('#sourceLang', 'en-CA');
    await speakerPage.fill('#targetLangs', 'fr-CA');

    // ===================================================================
    // LISTENER PAGE SETUP
    // ===================================================================

    console.log('[Test] Setting up listener page...');

    // Intercept listener console logs
    listenerPage.on('console', msg => {
      const text = msg.text();
      const timestamp = Date.now();

      if (text.includes('[listener] Hard patch rendered')) {
        try {
          const jsonMatch = text.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            metrics.translations.push({
              timestamp,
              unitId: data.unitId,
              text: data.text
            });
            console.log(`[Listener] Translation: ${data.text?.substring(0, 40)}...`);
          }
        } catch (e) {}
      }

      if (text.includes('[listener] TTS enqueued')) {
        try {
          const jsonMatch = text.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            metrics.ttsQueue.push({
              timestamp,
              queueSize: data.queueSize,
              unitId: data.unitId
            });
            console.log(`[Listener] TTS queue size: ${data.queueSize}`);
          }
        } catch (e) {}
      }

      if (text.includes('[listener] TTS playback started')) {
        try {
          const jsonMatch = text.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            console.log(`[Listener] TTS playback: queue latency=${data.queueLatencyMs}ms, queue=${data.remainingInQueue}`);
          }
        } catch (e) {}
      }
    });

    await listenerPage.goto(`${SERVER_URL}/listener.html`);

    // Configure listener
    await listenerPage.fill('#roomId', ROOM_ID);
    await listenerPage.selectOption('#targetLang', 'fr-CA');
    await listenerPage.check('#ttsToggle');

    // ===================================================================
    // FAKE MICROPHONE SETUP (Real-time audio streaming)
    // ===================================================================

    console.log('[Test] Injecting fake microphone with real-time audio...');

    // Read the WAV file
    const audioBuffer = readFileSync(AUDIO_FILE);
    const audioBase64 = audioBuffer.toString('base64');

    // Inject a fake getUserMedia that plays audio at real-time speed
    await speakerPage.addInitScript(({ audioData }) => {
      // Create an AudioContext to process the audio
      const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

      navigator.mediaDevices.getUserMedia = async function(constraints) {
        if (constraints.audio) {
          console.log('[FakeMic] Creating fake audio stream from WAV data...');

          // Decode the WAV file
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const audioArrayBuffer = Uint8Array.from(atob(audioData), c => c.charCodeAt(0)).buffer;
          const audioBuffer = await audioContext.decodeAudioData(audioArrayBuffer);

          console.log(`[FakeMic] Audio duration: ${audioBuffer.duration.toFixed(2)}s`);
          console.log(`[FakeMic] Sample rate: ${audioBuffer.sampleRate}Hz`);

          // Create a MediaStreamAudioDestinationNode to route audio to getUserMedia
          const destination = audioContext.createMediaStreamDestination();

          // Create a buffer source and play it at real-time speed
          const source = audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(destination);

          // Start playback NOW (real-time)
          source.start(0);

          console.log('[FakeMic] Audio playback started at real-time speed');

          return destination.stream;
        }

        return realGetUserMedia(constraints);
      };
    }, { audioData: audioBase64 });

    // ===================================================================
    // START THE TEST
    // ===================================================================

    console.log('[Test] Starting speaker capture...');
    const testStartTime = Date.now();

    await speakerPage.click('#startBtn');
    await speakerPage.waitForSelector('#recognitionStatus:has-text("Listening")', { timeout: 10000 });
    console.log('[Test] Speaker is listening');

    console.log('[Test] Connecting listener...');
    await listenerPage.click('#connectBtn');
    await listenerPage.waitForSelector('#connectionStatus:has-text("Connected")', { timeout: 10000 });
    console.log('[Test] Listener is connected');

    // ===================================================================
    // MONITOR FOR 8 MINUTES (FULL AUDIO DURATION)
    // ===================================================================

    console.log('[Test] Monitoring pipeline for ~8 minutes...');
    console.log('[Test] Watching for:');
    console.log('  - Fast-finals commits');
    console.log('  - Translations arriving');
    console.log('  - TTS queue behavior');
    console.log('');

    // Wait for audio to complete (~8 minutes) + buffer
    const AUDIO_DURATION_MS = 8 * 60 * 1000; // 8 minutes
    const BUFFER_MS = 30 * 1000; // 30 second buffer

    // Poll periodically to log progress
    const pollInterval = setInterval(() => {
      const elapsed = Date.now() - testStartTime;
      const elapsedMin = (elapsed / 1000 / 60).toFixed(1);
      console.log(`[Test] ${elapsedMin} minutes elapsed | Fast-finals: ${metrics.fastFinals.length} | Translations: ${metrics.translations.length} | Max queue: ${Math.max(...metrics.ttsQueue.map(q => q.queueSize), 0)}`);
    }, 15000); // Log every 15 seconds

    await speakerPage.waitForTimeout(AUDIO_DURATION_MS + BUFFER_MS);
    clearInterval(pollInterval);

    const testEndTime = Date.now();
    const totalTestTime = (testEndTime - testStartTime) / 1000;

    console.log('');
    console.log('[Test] Audio playback completed');
    console.log(`[Test] Total test time: ${totalTestTime.toFixed(1)}s`);

    // ===================================================================
    // COLLECT FINAL METRICS
    // ===================================================================

    console.log('');
    console.log('='.repeat(60));
    console.log('TEST RESULTS');
    console.log('='.repeat(60));
    console.log('');

    console.log(`Total test duration: ${totalTestTime.toFixed(1)} seconds`);
    console.log(`Fast-finals emitted: ${metrics.fastFinals.length}`);
    console.log(`Translations received: ${metrics.translations.length}`);
    console.log(`TTS queue events: ${metrics.ttsQueue.length}`);
    console.log('');

    if (metrics.ttsQueue.length > 0) {
      const maxQueue = Math.max(...metrics.ttsQueue.map(q => q.queueSize));
      const avgQueue = metrics.ttsQueue.reduce((sum, q) => sum + q.queueSize, 0) / metrics.ttsQueue.length;
      console.log(`TTS Queue Stats:`);
      console.log(`  Max queue size: ${maxQueue} items`);
      console.log(`  Avg queue size: ${avgQueue.toFixed(1)} items`);
      console.log('');
    }

    if (metrics.fastFinals.length > 0) {
      console.log(`Fast-finals examples:`);
      metrics.fastFinals.slice(0, 5).forEach((ff, i) => {
        console.log(`  ${i + 1}. ${ff.segment}`);
      });
      console.log('');
    }

    if (metrics.translations.length > 0) {
      console.log(`Translation examples:`);
      metrics.translations.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.text}`);
      });
      console.log('');
    }

    // Save metrics to file
    const metricsFile = join(process.cwd(), 'e2e-test-metrics.json');
    const fs = await import('fs');
    fs.writeFileSync(metricsFile, JSON.stringify({
      testDuration: totalTestTime,
      timestamp: new Date().toISOString(),
      metrics
    }, null, 2));
    console.log(`Metrics saved to: ${metricsFile}`);
    console.log('');

    // ===================================================================
    // ASSERTIONS
    // ===================================================================

    // Should have received at least some translations
    expect(metrics.translations.length).toBeGreaterThan(0);

    // Should have some fast-finals (with optimized config)
    expect(metrics.fastFinals.length).toBeGreaterThan(0);

    // Should have TTS queue activity
    expect(metrics.ttsQueue.length).toBeGreaterThan(0);

    console.log('✅ All assertions passed!');
    console.log('');

    // Cleanup
    await speakerContext.close();
    await listenerContext.close();
  });
});
