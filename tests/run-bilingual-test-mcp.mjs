#!/usr/bin/env node

/**
 * Run bilingual test using MCP Playwright server
 * This is a simpler alternative to the full Playwright test
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  serverUrl: 'http://localhost:3000',
  roomId: 'bilingual-mcp-test',
  sourceLang: 'en-US',  // Primary language (or use 'auto' if your room supports it)
  targetLang: 'fr-CA',  // Target translation language
  audioFile: path.join(__dirname, 'Bilingual_1min.wav'),
  timeoutMs: 90000,     // 90 seconds (60s audio + 30s processing)
  headed: true,         // Show browser for debugging
  targetSampleRate: 16000,
  mono: true,
  normalize: true,
  targetPeak: 0.9,
  playbackRate: 1.0,    // 1:1 real-time playback
};

console.log('');
console.log('='.repeat(70));
console.log('BILINGUAL TEST - MCP PLAYWRIGHT');
console.log('='.repeat(70));
console.log('');
console.log('Configuration:');
console.log(`  Audio file: ${config.audioFile}`);
console.log(`  Room ID: ${config.roomId}`);
console.log(`  Source language: ${config.sourceLang}`);
console.log(`  Target language: ${config.targetLang}`);
console.log(`  Playback rate: ${config.playbackRate}x (real-time)`);
console.log(`  Browser: ${config.headed ? 'visible' : 'headless'}`);
console.log('');

// Start MCP Playwright server
console.log('[MCP] Starting MCP Playwright server...');
const mcpServer = spawn('node', [
  path.join(__dirname, '../mcp/playwright-server/index.js')
], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// Wait for server to be ready
await new Promise(resolve => setTimeout(resolve, 2000));

console.log('[MCP] Server started, sending test request...');

// Send MCP tool call via stdin
const toolCall = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'run_fake_mic_session',
    arguments: config
  }
};

mcpServer.stdin.write(JSON.stringify(toolCall) + '\n');

// Read response
let responseBuffer = '';
mcpServer.stdout.on('data', (data) => {
  responseBuffer += data.toString();

  // Try to parse complete JSON responses
  const lines = responseBuffer.split('\n');
  responseBuffer = lines.pop() || ''; // Keep incomplete line

  lines.forEach(line => {
    if (line.trim()) {
      try {
        const response = JSON.parse(line);
        if (response.result) {
          const metrics = JSON.parse(response.result.content[0].text);

          console.log('');
          console.log('='.repeat(70));
          console.log('TEST RESULTS');
          console.log('='.repeat(70));
          console.log('');

          if (metrics.error) {
            console.error('❌ Test failed with error:');
            console.error(metrics.error);
          } else {
            console.log('Summary:');
            console.log(`  Duration: ${(metrics.summary.durationMs / 1000).toFixed(1)}s`);
            console.log(`  Translations: ${metrics.summary.translations}`);
            console.log(`  Fast finals: ${metrics.summary.fastFinals}`);
            console.log(`  TTS events: ${metrics.summary.ttsEvents}`);
            console.log('');

            if (metrics.translations.length > 0) {
              console.log('Sample translations:');
              metrics.translations.slice(0, 5).forEach((t, i) => {
                console.log(`  ${i + 1}. ${t.text?.substring(0, 60) || '(empty)'}...`);
              });
              console.log('');
            }

            if (metrics.errors.length > 0) {
              console.log('⚠️  Errors encountered:');
              metrics.errors.forEach((e, i) => {
                console.log(`  ${i + 1}. ${e}`);
              });
              console.log('');
            }

            console.log('✅ Test completed successfully!');
            console.log('');
            console.log('Verification checklist:');
            console.log(`  ${metrics.summary.translations > 0 ? '✓' : '✗'} Transcriptions generated`);
            console.log(`  ${metrics.summary.fastFinals > 0 ? '✓' : '✗'} Fast finals detected`);
            console.log(`  ${metrics.summary.ttsEvents > 0 ? '✓' : '✗'} TTS events captured`);
            console.log(`  ${metrics.errors.length === 0 ? '✓' : '✗'} No errors`);
          }

          // Cleanup
          mcpServer.kill();
          process.exit(0);
        }
      } catch (e) {
        // Not JSON or incomplete, ignore
      }
    }
  });
});

mcpServer.on('error', (error) => {
  console.error('[MCP] Server error:', error);
  process.exit(1);
});

mcpServer.on('exit', (code) => {
  console.log(`[MCP] Server exited with code ${code}`);
  if (code !== 0) {
    process.exit(code);
  }
});

// Timeout safety
setTimeout(() => {
  console.error('[MCP] Test timeout exceeded!');
  mcpServer.kill();
  process.exit(1);
}, config.timeoutMs + 10000);
