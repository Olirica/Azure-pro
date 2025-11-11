/**
 * Quick 2-Minute Hybrid E2E Test
 * Tests TTS deduplication and speed modifier
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { join } from 'path';

const SERVER_URL = 'http://localhost:3000';
const ROOM_ID = 'e2e-quick-test';
const AUDIO_FILE = '/Users/olivierlepage/code/azure-pro/tests/pipeline-bench/samples/conference_full.wav';

test.setTimeout(180000); // 3 minutes

test.describe('Quick 2-Min Pipeline Test', () => {

  test('2-minute test with deduplication', async ({ browser }) => {

    const listenerContext = await browser.newContext({
      permissions: [],
      bypassCSP: true
    });

    const listenerPage = await listenerContext.newPage();

    const metrics = {
      translations: [],
      ttsQueue: [],
      ttsSkipped: [],
      errors: []
    };

    listenerPage.on('console', msg => {
      const text = msg.text();
      const timestamp = Date.now();

      if (text.includes('[listener] Hard patch rendered')) {
        try {
          const jsonMatch = text.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            metrics.translations.push({ timestamp, unitId: data.unitId, text: data.text });
            console.log(`[Listener] Translation: ${data.text?.substring(0, 40)}...`);
          }
        } catch (e) {}
      }

      if (text.includes('[listener] TTS enqueued')) {
        try {
          const jsonMatch = text.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            metrics.ttsQueue.push({ timestamp, queueSize: data.queueSize });
            console.log(`[Listener] TTS queue: ${data.queueSize}`);
          }
        } catch (e) {}
      }

      if (text.includes('[listener] Skipping')) {
        metrics.ttsSkipped.push({ timestamp, text });
        console.log(`[Listener] ${text}`);
      }
    });

    await listenerPage.goto(`${SERVER_URL}/listener.html`);
    await listenerPage.fill('#roomId', ROOM_ID);
    await listenerPage.selectOption('#targetLang', 'fr-CA');
    await listenerPage.check('#ttsToggle');
    await listenerPage.click('#connectBtn');
    await listenerPage.waitForSelector('#connectionStatus:has-text("Connected")', { timeout: 10000 });

    console.log('[Test] Starting 2-minute hybrid STT processor...');
    const testStartTime = Date.now();

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

    let sttOutput = '';
    processor.stdout.on('data', (data) => {
      sttOutput += data.toString();
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        try {
          const json = JSON.parse(line);
          if (json.ev === 'posted') {
            console.log(`[STT] Posted: ${json.text?.substring(0, 40)}...`);
          }
        } catch (e) {}
      });
    });

    // Wait 2 minutes
    await new Promise(resolve => setTimeout(resolve, 120000));

    // Kill STT processor
    processor.kill();

    // Wait for listener to finish playing
    console.log('[Test] Waiting for TTS queue to drain...');
    await listenerPage.waitForTimeout(10000);

    const testEndTime = Date.now();
    const totalTestTime = (testEndTime - testStartTime) / 1000;

    console.log('');
    console.log('='.repeat(60));
    console.log('2-MINUTE TEST RESULTS');
    console.log('='.repeat(60));
    console.log('');

    console.log(`Test duration: ${totalTestTime.toFixed(1)}s`);
    console.log(`Translations: ${metrics.translations.length}`);
    console.log(`TTS enqueued: ${metrics.ttsQueue.length}`);
    console.log(`TTS skipped (dedup): ${metrics.ttsSkipped.length}`);
    console.log('');

    if (metrics.ttsQueue.length > 0) {
      const maxQueue = Math.max(...metrics.ttsQueue.map(q => q.queueSize));
      const avgQueue = metrics.ttsQueue.reduce((sum, q) => sum + q.queueSize, 0) / metrics.ttsQueue.length;
      console.log(`TTS Queue Stats:`);
      console.log(`  Max: ${maxQueue} items`);
      console.log(`  Avg: ${avgQueue.toFixed(1)} items`);
      console.log('');
    }

    console.log(`Deduplication working: ${metrics.ttsSkipped.length > 0 ? '✅ YES' : '❌ NO'}`);
    console.log('');

    // Save metrics
    const fs = await import('fs');
    fs.writeFileSync('e2e-2min-metrics.json', JSON.stringify({
      testDuration: totalTestTime,
      timestamp: new Date().toISOString(),
      metrics
    }, null, 2));

    // Assertions
    expect(metrics.translations.length).toBeGreaterThan(0);
    expect(metrics.ttsQueue.length).toBeGreaterThan(0);
    expect(metrics.ttsSkipped.length).toBeGreaterThan(0); // Should have deduplicated some

    console.log('✅ Test passed!');

    await listenerContext.close();
  });
});
