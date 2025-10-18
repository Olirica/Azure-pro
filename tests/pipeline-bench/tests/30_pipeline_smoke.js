import 'dotenv/config';
import WebSocket from 'ws';
import axios from 'axios';
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
  return new Promise((resolve, reject) => {
    // Build WebSocket URL with query parameters (server expects these in URL, not in messages)
    const url = new URL(argv.server);
    url.searchParams.set('room', argv.room);
    url.searchParams.set('role', 'listener');
    url.searchParams.set('lang', argv.lang);
    url.searchParams.set('tts', 'true');

    listenerWS = new WebSocket(url.toString());
    const timeout = setTimeout(() => reject(new Error('Listener connection timeout after 5s')), 5000);

    listenerWS.on('open', () => {
      console.log(JSON.stringify({ev:'listener-connected', t_ms: Date.now()-t0}));
    });

    listenerWS.on('message', (buf) => {
      const m = JSON.parse(buf.toString());

      if (m.type === 'hello') {
        clearTimeout(timeout);
        console.log(JSON.stringify({ev:'listener-hello', t_ms: Date.now()-t0, payload: m.payload}));
        resolve();
      }

      if (m.type === 'patch') {
        const patch = m.payload;
        console.log(JSON.stringify({ev:'listener-patch', t_ms: Date.now()-t0, stage: patch.stage, type: patch.type, text: patch.text?.substring(0, 50)}));

        // Check for hard final translated text
        if (patch.stage === 'hard' && patch.text) {
          gotFinalText = true;
        }
      }

      // TTS arrives as separate message
      if (m.type === 'tts') {
        const payload = m.payload;
        gotTts = true;
        console.log(JSON.stringify({ev:'listener-tts', t_ms: Date.now()-t0, unitId: payload.unitId, bytes: payload.b64?.length || 0}));
      }
    });

    listenerWS.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Listener WebSocket error: ${err.message}`));
    });

    listenerWS.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

function connectSpeaker() {
  return new Promise((resolve, reject) => {
    // Build WebSocket URL with query parameters (server expects these in URL, not in messages)
    const url = new URL(argv.server);
    url.searchParams.set('room', argv.room);
    url.searchParams.set('role', 'speaker');
    url.searchParams.set('lang', 'en-US');

    speakerWS = new WebSocket(url.toString());
    const timeout = setTimeout(() => reject(new Error('Speaker connection timeout after 5s')), 5000);

    speakerWS.on('open', () => {
      console.log(JSON.stringify({ev:'speaker-connected', t_ms: Date.now()-t0}));
    });

    speakerWS.on('message', (buf) => {
      const m = JSON.parse(buf.toString());

      if (m.type === 'hello') {
        clearTimeout(timeout);
        console.log(JSON.stringify({ev:'speaker-hello', t_ms: Date.now()-t0, payload: m.payload}));
        resolve();
      }
    });

    speakerWS.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Speaker WebSocket error: ${err.message}`));
    });

    speakerWS.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

async function run() {
  await connectListener();
  await connectSpeaker();

  // Build HTTP API base URL from WebSocket URL
  const wsUrl = new URL(argv.server);
  const httpBase = `${wsUrl.protocol === 'wss:' ? 'https:' : 'http:'}//${wsUrl.host}`;

  // Send 3 prefix patches via HTTP API
  let srcStart=0;
  for (let i=0;i<segments.length-1;i++) {
    const seg = segments[i];
    const srcEnd = srcStart + seg.length + 1;

    const patch = {
      stage: 'soft',
      type: 'prefix',
      unitId: 'u-test',
      version: i+1,
      seq: i+1,
      text: seg,
      srcStart,
      srcEnd
    };

    console.log(JSON.stringify({ev:'sending-prefix', seq: i+1, t_ms: Date.now()-t0}));
    await axios.post(`${httpBase}/api/segments`, {
      roomId: argv.room,
      patch,
      targets: [argv.lang]
    });

    srcStart = srcEnd;
    await new Promise(r=>setTimeout(r, 300));
  }

  // Send final patch (version should be higher than all prefixes)
  const finalPatch = {
    stage: 'hard',
    type: 'final',
    unitId: 'u-test',
    version: segments.length,  // version 3 (after 2 prefixes)
    text: text
  };

  console.log(JSON.stringify({ev:'sending-final', t_ms: Date.now()-t0}));
  await axios.post(`${httpBase}/api/segments`, {
    roomId: argv.room,
    patch: finalPatch,
    targets: [argv.lang]
  });

  // Wait for translation and TTS (longer wait for final + TTS generation)
  // TTS comes in separate patches after translation
  await new Promise(r=>setTimeout(r, 12000));

  // Cleanup connections
  if (speakerWS) speakerWS.close();
  if (listenerWS) listenerWS.close();

  if (!gotFinalText || !gotTts) {
    console.error('Smoke failed: finalText=', gotFinalText, ' tts=', gotTts);
    process.exit(2);
  }
  console.log(JSON.stringify({ev:'ok', total_ms: Date.now()-t0}));
  process.exit(0);
}
run().catch(e=>{
  console.error('Test failed:', e.message);
  if (speakerWS) speakerWS.close();
  if (listenerWS) listenerWS.close();
  process.exit(1);
});
