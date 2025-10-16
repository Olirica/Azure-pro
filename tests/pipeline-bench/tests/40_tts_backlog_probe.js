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
  .argv;

let ws;
let t0 = Date.now();
let bytesTotal=0;
let tLast=Date.now();

ws = new WebSocket(argv.server);
ws.on('open', () => {
  ws.send(JSON.stringify({ type:'hello', role:'listener', token: argv.listener, room: argv.room, lang: argv.lang, tts:1 }));
});
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.type === 'tts' && m.b64) {
    const now = Date.now();
    const dt = (now - tLast)/1000;
    tLast = now;
    bytesTotal += m.b64.length;
    // Rough bitrate-based duration estimate for mp3 48kbps
    const estSec = (m.b64.length * 3 / 4) * 8 / 48000;
    const drift = estSec - dt;
    console.log(JSON.stringify({ev:'tts', dt_s: dt, est_s: estSec, drift_s: drift}));
    if (drift > argv.maxDriftSec) {
      console.error('Backlog increasing too fast, drift:', drift);
      process.exit(2);
    }
  }
});
