import 'dotenv/config';

const required = [
  'SPEECH_KEY','SPEECH_REGION',
  'TRANSLATOR_KEY','TRANSLATOR_REGION',
  'SERVER_WS_URL','SPEAKER_TOKEN','LISTENER_TOKEN','ROOM'
];
let ok=true;
for (const k of required) {
  if (!process.env[k] || !String(process.env[k]).trim()) { console.error('Missing env:', k); ok=false; }
}
if (!ok) { process.exit(1); }
console.log('All required env present.');
