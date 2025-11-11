import 'dotenv/config';
import WebSocket from 'ws';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('server', {type:'string', default: process.env.SERVER_WS_URL})
  .option('room', {type:'string', default: process.env.ROOM || 'demo-room'})
  .option('listener', {type:'string', default: process.env.LISTENER_TOKEN})
  .option('lang', {type:'string', default: process.env.DEFAULT_TARGET_LANG || 'fr-FR'})
  .option('maxDriftSec', {type:'number', default: 3})
  .option('timeoutSec', {type:'number', default: 60, description: 'Max time to wait for TTS events'})
  .option('minEvents', {type:'number', default: 3, description: 'Minimum TTS events required for success'})
  .argv;

let ws;
let t0 = Date.now();
let bytesTotal=0;
let tLast=Date.now();
let ttsEventCount = 0;
let lastActivityTime = Date.now();
let connected = false;

// Timeout handler - exit if no activity for too long
const activityTimeout = setInterval(() => {
  const idleMs = Date.now() - lastActivityTime;
  const totalMs = Date.now() - t0;

  if (totalMs > argv.timeoutSec * 1000) {
    console.error(`Test timeout after ${argv.timeoutSec}s. Events received: ${ttsEventCount}`);
    if (ttsEventCount >= argv.minEvents) {
      console.log(JSON.stringify({ev:'ok', total_s: totalMs/1000, tts_events: ttsEventCount}));
      process.exit(0);
    } else {
      console.error(`Not enough TTS events (${ttsEventCount} < ${argv.minEvents})`);
      process.exit(2);
    }
  }

  // If connected but no TTS for 10s, might be done
  if (connected && idleMs > 10000 && ttsEventCount >= argv.minEvents) {
    console.log(JSON.stringify({ev:'ok', total_s: totalMs/1000, tts_events: ttsEventCount, reason: 'idle'}));
    process.exit(0);
  }
}, 1000);

ws = new WebSocket(argv.server);

const connectTimeout = setTimeout(() => {
  console.error('Connection timeout after 5s');
  clearInterval(activityTimeout);
  process.exit(1);
}, 5000);

ws.on('open', () => {
  clearTimeout(connectTimeout);
  connected = true;
  lastActivityTime = Date.now();
  console.log(JSON.stringify({ev:'connected', t_ms: Date.now()-t0}));
  ws.send(JSON.stringify({ type:'hello', role:'listener', token: argv.listener, room: argv.room, lang: argv.lang, tts:1 }));
});

ws.on('message', (buf) => {
  lastActivityTime = Date.now();
  const m = JSON.parse(buf.toString());

  if (m.type === 'ok') {
    console.log(JSON.stringify({ev:'authenticated', t_ms: Date.now()-t0}));
  }

  if (m.type === 'tts' && m.b64) {
    ttsEventCount++;
    const now = Date.now();
    const dt = (now - tLast)/1000;
    tLast = now;
    bytesTotal += m.b64.length;
    // Rough bitrate-based duration estimate for mp3 48kbps
    const estSec = (m.b64.length * 3 / 4) * 8 / 48000;
    const drift = estSec - dt;
    console.log(JSON.stringify({ev:'tts', event_num: ttsEventCount, dt_s: dt, est_s: estSec, drift_s: drift}));
    if (drift > argv.maxDriftSec) {
      console.error('Backlog increasing too fast, drift:', drift);
      clearInterval(activityTimeout);
      ws.close();
      process.exit(2);
    }
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  clearTimeout(connectTimeout);
  clearInterval(activityTimeout);
  process.exit(1);
});

ws.on('close', () => {
  console.log(JSON.stringify({ev:'closed', t_ms: Date.now()-t0, tts_events: ttsEventCount}));
  clearTimeout(connectTimeout);
  clearInterval(activityTimeout);
  if (ttsEventCount >= argv.minEvents) {
    process.exit(0);
  } else {
    console.error(`Not enough TTS events (${ttsEventCount} < ${argv.minEvents})`);
    process.exit(2);
  }
});
