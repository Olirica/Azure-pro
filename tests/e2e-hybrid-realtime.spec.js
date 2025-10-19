/**
 * Hybrid E2E Real-Time Test
 *
 * This test combines:
 * 1. Node.js Azure Speech SDK (file harness) for STT processing
 * 2. HTTP POSTs to server simulating speaker page
 * 3. Playwright listener page to receive translations/TTS
 *
 * This avoids the Azure SDK browser limitation while still testing
 * the full pipeline at real-time speed.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const SERVER_URL = 'http://localhost:3000';
const ROOM_ID = 'e2e-hybrid-test';
const AUDIO_FILE = '/Users/olivierlepage/code/azure-pro/tests/pipeline-bench/samples/conference_full.wav';

test.setTimeout(600000); // 10 minutes

test.describe('Hybrid Real-Time Pipeline Test', () => {

  test('8-minute conference with real-time server POSTs', async ({ browser }) => {

    // ===================================================================
    // LISTENER PAGE SETUP
    // ===================================================================

    console.log('[Test] Setting up listener page...');

    const listenerContext = await browser.newContext({
      permissions: [],
      bypassCSP: true
    });

    const listenerPage = await listenerContext.newPage();

    // Metrics collection
    const metrics = {
      translations: [],
      ttsQueue: [],
      ttsPlayback: [],
      errors: []
    };

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
            console.log(`[Listener] TTS queue: ${data.queueSize} items`);
          }
        } catch (e) {}
      }

      if (text.includes('[listener] TTS playback started')) {
        try {
          const jsonMatch = text.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            metrics.ttsPlayback.push({
              timestamp,
              queueLatencyMs: data.queueLatencyMs,
              remainingInQueue: data.remainingInQueue
            });
            console.log(`[Listener] TTS playback: latency=${data.queueLatencyMs}ms, queue=${data.remainingInQueue}`);
          }
        } catch (e) {}
      }

      if (text.includes('[listener] Error') || text.includes('error')) {
        metrics.errors.push({ timestamp, text });
      }
    });

    await listenerPage.goto(`${SERVER_URL}/listener.html`);
    await listenerPage.fill('#roomId', ROOM_ID);
    await listenerPage.selectOption('#targetLang', 'fr-CA');
    await listenerPage.check('#ttsToggle');

    console.log('[Test] Connecting listener...');
    await listenerPage.click('#connectBtn');
    await listenerPage.waitForSelector('#connectionStatus:has-text("Connected")', { timeout: 10000 });
    console.log('[Test] Listener connected');

    // ===================================================================
    // START HYBRID STT PROCESSOR (Node.js + HTTP POST)
    // ===================================================================

    console.log('[Test] Starting hybrid STT processor...');
    console.log('[Test] This will POST recognition results to server in real-time');

    const testStartTime = Date.now();

    // Spawn the hybrid processor as a child process
    const processor = spawn('node', [
      'tests/hybrid-stt-poster.mjs',
      '--wav', AUDIO_FILE,
      '--lang', 'en-CA',
      '--room', ROOM_ID,
      '--targetLangs', 'fr-CA',
      '--serverUrl', SERVER_URL
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let processorOutput = '';

    processor.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        processorOutput += line + '\n';
        try {
          const json = JSON.parse(line);
          if (json.ev === 'recognizing') {
            console.log(`[STT] Recognizing: ${json.text?.substring(0, 40)}...`);
          } else if (json.ev === 'final') {
            console.log(`[STT] Final: ${json.text?.substring(0, 40)}...`);
          } else if (json.ev === 'posted') {
            console.log(`[STT] Posted patch: ${json.patchType} (${json.httpStatus})`);
          } else if (json.ev === 'error') {
            console.error(`[STT] Error: ${json.message}`);
            metrics.errors.push({ timestamp: Date.now(), text: json.message });
          }
        } catch (e) {
          // Not JSON, just log it
          console.log(`[STT] ${line}`);
        }
      });
    });

    processor.stderr.on('data', (data) => {
      console.error(`[STT Error] ${data.toString()}`);
      metrics.errors.push({ timestamp: Date.now(), text: data.toString() });
    });

    // Wait for processor to complete
    const processorExitCode = await new Promise((resolve) => {
      processor.on('close', (code) => {
        console.log(`[Test] STT processor exited with code ${code}`);
        resolve(code);
      });
    });

    // Give listener a few more seconds to finish playing queued TTS
    console.log('[Test] Waiting for TTS queue to drain...');
    await listenerPage.waitForTimeout(10000);

    const testEndTime = Date.now();
    const totalTestTime = (testEndTime - testStartTime) / 1000;

    // ===================================================================
    // COLLECT RESULTS
    // ===================================================================

    console.log('');
    console.log('='.repeat(60));
    console.log('HYBRID TEST RESULTS');
    console.log('='.repeat(60));
    console.log('');

    console.log(`Total test duration: ${totalTestTime.toFixed(1)} seconds`);
    console.log(`Translations received: ${metrics.translations.length}`);
    console.log(`TTS queue events: ${metrics.ttsQueue.length}`);
    console.log(`TTS playback events: ${metrics.ttsPlayback.length}`);
    console.log(`Errors: ${metrics.errors.length}`);
    console.log('');

    if (metrics.ttsQueue.length > 0) {
      const maxQueue = Math.max(...metrics.ttsQueue.map(q => q.queueSize));
      const avgQueue = metrics.ttsQueue.reduce((sum, q) => sum + q.queueSize, 0) / metrics.ttsQueue.length;
      console.log(`TTS Queue Stats:`);
      console.log(`  Max queue size: ${maxQueue} items`);
      console.log(`  Avg queue size: ${avgQueue.toFixed(1)} items`);
      console.log('');
    }

    if (metrics.ttsPlayback.length > 0) {
      const latencies = metrics.ttsPlayback.map(p => p.queueLatencyMs);
      const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      console.log(`TTS Latency Stats:`);
      console.log(`  Avg queue latency: ${avgLatency.toFixed(0)}ms`);
      console.log(`  Max queue latency: ${maxLatency}ms`);
      console.log('');
    }

    if (metrics.translations.length > 0) {
      console.log(`Translation examples:`);
      metrics.translations.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.text}`);
      });
      console.log('');
    }

    if (metrics.errors.length > 0) {
      console.log(`Errors encountered:`);
      metrics.errors.slice(0, 5).forEach((e, i) => {
        console.log(`  ${i + 1}. ${e.text.substring(0, 100)}`);
      });
      console.log('');
    }

    // Save metrics
    const fs = await import('fs');
    fs.writeFileSync('e2e-hybrid-metrics.json', JSON.stringify({
      testDuration: totalTestTime,
      timestamp: new Date().toISOString(),
      metrics,
      processorExitCode,
      processorOutput
    }, null, 2));
    console.log(`Metrics saved to: e2e-hybrid-metrics.json`);
    console.log('');

    // ===================================================================
    // ASSERTIONS
    // ===================================================================

    // STT processor should complete successfully
    expect(processorExitCode).toBe(0);

    // Should have received translations
    expect(metrics.translations.length).toBeGreaterThan(0);

    // Should have TTS activity
    expect(metrics.ttsQueue.length).toBeGreaterThan(0);

    // Should not have critical errors
    expect(metrics.errors.length).toBe(0);

    console.log('✅ All assertions passed!');
    console.log('');

    await listenerContext.close();
  });
});
