import 'dotenv/config';
import WebSocket from 'ws';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option('server', {type:'string', default: process.env.SERVER_WS_URL})
  .option('room', {type:'string', default: process.env.ROOM || 'demo-room'})
  .option('speaker', {type:'string', default: process.env.SPEAKER_TOKEN})
  .option('listener', {type:'string', default: process.env.LISTENER_TOKEN})
  .option('lang', {type:'string', default: process.env.DEFAULT_TARGET_LANG || 'fr-FR'})
  .argv;

// Tiny script: injects 3 prefix chunks + final remainder; listener must receive final text + tts
const text = "Hello everyone and welcome to today's conference. We'll take questions at the very end. Grab a coffee and we'll begin shortly.";
const segments = [
  "Hello everyone and welcome to today's conference.",
  "We'll take questions at the very end.",
  "Grab a coffee and we'll begin shortly."
];

const t0 = Date.now();
let speakerWS, listenerWS;
let gotFinalText=false, gotTts=false;

function connectListener() {
  return new Promise((resolve) => {
    listenerWS = new WebSocket(argv.server);
    listenerWS.on('open', () => {
      listenerWS.send(JSON.stringify({ type:'hello', role:'listener', token: argv.listener, room: argv.room, lang: argv.lang, tts:1 }));
    });
    listenerWS.on('message', (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === 'ok') resolve();
      if (m.type === 'final') {
        gotFinalText = true;
        console.log(JSON.stringify({ev:'listener-final', t_ms: Date.now()-t0, text: m.text}));
      }
      if (m.type === 'tts') {
        gotTts = true;
        console.log(JSON.stringify({ev:'listener-tts', t_ms: Date.now()-t0, bytes: (m.b64?.length||0)}));
      }
    });
  });
}

function connectSpeaker() {
  return new Promise((resolve) => {
    speakerWS = new WebSocket(argv.server);
    speakerWS.on('open', () => {
      speakerWS.send(JSON.stringify({ type:'hello', role:'speaker', token: argv.speaker, room: argv.room, lang: 'en-US' }));
      resolve();
    });
  });
}

async function run() {
  await connectListener();
  await connectSpeaker();

  // Send 3 prefixes quickly
  let srcStart=0;
  for (let i=0;i<segments.length-1;i++) {
    const seg = segments[i];
    const srcEnd = srcStart + seg.length + 1; // include space/punct approx
    speakerWS.send(JSON.stringify({ type:'prefix', unitId:'u-test', seq:i+1, text: seg, srcStart, srcEnd }));
    srcStart = srcEnd;
    await new Promise(r=>setTimeout(r, 300));
  }
  // Send final remainder
  const remainder = segments[segments.length-1];
  speakerWS.send(JSON.stringify({ type:'final', unitId:'u-test', version:1, text: text }));

  // Wait a bit for responses
  await new Promise(r=>setTimeout(r, 4000));
  if (!gotFinalText || !gotTts) { console.error('Smoke failed: finalText=', gotFinalText, ' tts=', gotTts); process.exit(2); }
  console.log(JSON.stringify({ev:'ok', total_ms: Date.now()-t0}));
  process.exit(0);
}
run().catch(e=>{ console.error(e); process.exit(1); });
