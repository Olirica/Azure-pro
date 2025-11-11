import 'dotenv/config';

// Core Azure credentials (always required)
const required = [
  'SPEECH_KEY','SPEECH_REGION',
  'TRANSLATOR_KEY','TRANSLATOR_REGION'
];

// WebSocket test credentials (optional - can be provided via CLI args)
const optional = [
  'SERVER_WS_URL','SPEAKER_TOKEN','LISTENER_TOKEN','ROOM'
];

let ok=true;
const missing = [];
const missingOptional = [];

for (const k of required) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error('Missing required env:', k);
    missing.push(k);
    ok=false;
  }
}

for (const k of optional) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    missingOptional.push(k);
  }
}

if (!ok) {
  console.error('Required environment variables are missing:', missing.join(', '));
  process.exit(1);
}

if (missingOptional.length > 0) {
  console.log('Optional env vars missing (can be passed via CLI args):', missingOptional.join(', '));
}

console.log('All required env present. WebSocket tests can use CLI args if needed.');
