const WebSocket = require('ws');

const url = process.argv[2] || 'ws://localhost:3000/ws?room=demo-room&role=listener&lang=fr-FR';
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('open');
});
ws.on('message', (data) => {
  console.log('message', data.toString());
});
ws.on('close', (code, reason) => {
  console.log('close', code, reason.toString());
  clearTimeout(timeout);
});
ws.on('error', (err) => {
  console.error('error', err);
});

const timeout = setTimeout(() => {
  console.log('closing after timeout');
  ws.close();
}, 60000);
