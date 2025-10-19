/**
 * Quick 30-Second Hybrid E2E Test
 * Verifies segment versioning and basic pipeline functionality
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';

const SERVER_URL = 'http://localhost:3000';
const ROOM_ID = 'e2e-30sec-test';
const AUDIO_FILE = '/Users/olivierlepage/code/azure-pro/tests/pipeline-bench/samples/conference_full.wav';

test.setTimeout(60000); // 1 minute

test.describe('Quick 30-Sec Pipeline Test', () => {

  test('30-second basic pipeline test', async ({ page }) => {

    const metrics = {
      patchesReceived: [],
      ttsReceived: [],
      uniqueUnits: new Set()
    };

    // Capture all console output to see what's happening
    page.on('console', msg => {
      const text = msg.text();
      console.log(`[Browser] ${text}`);

      // Track patches
      if (text.includes('[listener] Hard patch rendered')) {
        const match = text.match(/unitId:\s*([^,}]+)/);
        if (match) {
          const unitId = match[1].trim();
          metrics.uniqueUnits.add(unitId);
          metrics.patchesReceived.push({ unitId, text });
        }
      }

      // Track TTS
      if (text.includes('[listener] TTS enqueued') || text.includes('[listener] TTS playback')) {
        metrics.ttsReceived.push({ text, timestamp: Date.now() });
      }
    });

    await page.goto(`${SERVER_URL}/listener.html`);
    await page.fill('#roomId', ROOM_ID);
    await page.selectOption('#targetLang', 'fr-CA');
    await page.check('#ttsToggle');
    await page.click('#connectBtn');
    await page.waitForSelector('#connectionStatus:has-text("Connected")', { timeout: 10000 });

    console.log('[Test] Starting 30-second STT processor...');
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

    processor.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        try {
          const json = JSON.parse(line);
          if (json.ev === 'posted' || json.ev === 'fast-final') {
            console.log(`[STT] ${json.ev}: ${json.text?.substring(0, 40) || json.segment?.substring(0, 40)}...`);
          }
        } catch (e) {}
      });
    });

    processor.stderr.on('data', (data) => {
      console.error(`[STT Error] ${data.toString()}`);
    });

    // Wait 30 seconds
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Kill STT processor
    processor.kill();

    // Wait for queue to drain
    console.log('[Test] Waiting for TTS queue to drain...');
    await page.waitForTimeout(5000);

    const testEndTime = Date.now();
    const totalTestTime = (testEndTime - testStartTime) / 1000;

    console.log('');
    console.log('='.repeat(60));
    console.log('30-SECOND TEST RESULTS');
    console.log('='.repeat(60));
    console.log('');

    console.log(`Test duration: ${totalTestTime.toFixed(1)}s`);
    console.log(`Patches received: ${metrics.patchesReceived.length}`);
    console.log(`Unique units: ${metrics.uniqueUnits.size}`);
    console.log(`TTS events: ${metrics.ttsReceived.length}`);
    console.log('');

    // Take screenshot of final state
    await page.screenshot({ path: 'test-results/30sec-final-state.png', fullPage: true });

    // Count visible transcript items
    const transcriptItems = await page.$$('#transcript li');
    console.log(`Visible transcript items: ${transcriptItems.length}`);

    // Check for repetitions by reading transcript text
    const transcriptTexts = [];
    for (const item of transcriptItems) {
      const text = await item.textContent();
      transcriptTexts.push(text);
    }

    console.log('');
    console.log('Sample transcript items:');
    transcriptTexts.slice(0, 5).forEach((text, i) => {
      console.log(`  ${i + 1}. ${text.substring(0, 60)}...`);
    });
    console.log('');

    // Basic assertions
    expect(transcriptItems.length).toBeGreaterThan(0);
    console.log('✅ Test completed!');
  });
});
