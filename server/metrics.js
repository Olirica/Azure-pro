const client = require('prom-client');

const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'polyglot_rt_' });

const patchCounter = new client.Counter({
  name: 'polyglot_rt_patch_total',
  help: 'Count of processed patches grouped by stage and status.',
  labelNames: ['room', 'stage', 'status']
});

const patchDropCounter = new client.Counter({
  name: 'polyglot_rt_patch_dropped_total',
  help: 'Count of patches dropped due to stale version or validation failures.',
  labelNames: ['room', 'reason']
});

const translationLatencyHistogram = new client.Histogram({
  name: 'polyglot_rt_translation_latency_seconds',
  help: 'Translation latency in seconds per target language.',
  labelNames: ['room', 'lang'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10]
});

const ttsBacklogGauge = new client.Gauge({
  name: 'polyglot_rt_tts_backlog_seconds',
  help: 'Estimated queued TTS backlog in seconds per room/language.',
  labelNames: ['room', 'lang']
});

const ttsEventCounter = new client.Counter({
  name: 'polyglot_rt_tts_events_total',
  help: 'TTS queue events.',
  labelNames: ['room', 'lang', 'event']
});

const translatorCounter = new client.Counter({
  name: 'polyglot_rt_translator_requests_total',
  help: 'Translator REST usage grouped by language and outcome.',
  labelNames: ['room', 'lang', 'outcome']
});

const watchdogCounter = new client.Counter({
  name: 'polyglot_rt_watchdog_triggers_total',
  help: 'Watchdog restart advisories per room.',
  labelNames: ['room']
});

const wsClientsGauge = new client.Gauge({
  name: 'polyglot_rt_ws_clients',
  help: 'Current WebSocket connections per room and role.',
  labelNames: ['room', 'role']
});

// STT Metrics
const sttTtftHistogram = new client.Histogram({
  name: 'polyglot_rt_stt_ttft_seconds',
  help: 'Time to first token (soft patch) in seconds.',
  labelNames: ['room', 'provider'],
  buckets: [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5]
});

const sttTtfcHistogram = new client.Histogram({
  name: 'polyglot_rt_stt_ttfc_seconds',
  help: 'Time to first commit (hard patch) in seconds.',
  labelNames: ['room', 'provider'],
  buckets: [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10]
});

const sttLatencyHistogram = new client.Histogram({
  name: 'polyglot_rt_stt_latency_seconds',
  help: 'STT end-to-end latency per patch in seconds.',
  labelNames: ['room', 'provider', 'stage'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5]
});

const sttSessionCounter = new client.Counter({
  name: 'polyglot_rt_stt_sessions_total',
  help: 'Total STT sessions created.',
  labelNames: ['room', 'provider']
});

const sttFallbackCounter = new client.Counter({
  name: 'polyglot_rt_stt_fallback_total',
  help: 'STT provider fallback events.',
  labelNames: ['primary', 'fallback']
});

const requestDuration = new client.Histogram({
  name: 'polyglot_rt_http_duration_seconds',
  help: 'HTTP request duration.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]
});

function httpMetricsMiddleware(req, res, next) {
  const end = requestDuration.startTimer({ method: req.method, route: req.route?.path || req.path });
  res.on('finish', () => {
    end({ status: res.statusCode });
  });
  next();
}

function observePatch(room, stage, status) {
  patchCounter.inc({ room, stage, status });
}

function dropPatch(room, reason) {
  patchDropCounter.inc({ room, reason });
}

function observeTranslationLatency(room, lang, seconds) {
  translationLatencyHistogram.observe({ room, lang }, seconds);
}

function observeTranslator(room, lang, outcome) {
  translatorCounter.inc({ room, lang, outcome });
}

function setTtsBacklog(room, lang, seconds) {
  ttsBacklogGauge.set({ room, lang }, seconds);
}

function recordTtsEvent(room, lang, event) {
  ttsEventCounter.inc({ room, lang, event });
}

function trackWsConnection(room, role, delta) {
  wsClientsGauge.inc({ room, role }, delta);
}

function recordWatchdogTrigger(room) {
  watchdogCounter.inc({ room });
}

// STT metric helpers
function observeSttTtft(room, provider, seconds) {
  sttTtftHistogram.observe({ room, provider }, seconds);
}

function observeSttTtfc(room, provider, seconds) {
  sttTtfcHistogram.observe({ room, provider }, seconds);
}

function observeSttLatency(room, provider, stage, seconds) {
  sttLatencyHistogram.observe({ room, provider, stage }, seconds);
}

function recordSttSession(room, provider) {
  sttSessionCounter.inc({ room, provider });
}

function recordSttFallback(primary, fallback) {
  sttFallbackCounter.inc({ primary, fallback });
}

async function sendMetrics(req, res) {
  res.setHeader('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
}

module.exports = {
  httpMetricsMiddleware,
  observePatch,
  dropPatch,
  observeTranslationLatency,
  observeTranslator,
  setTtsBacklog,
  recordTtsEvent,
  trackWsConnection,
  recordWatchdogTrigger,
  // STT metrics
  observeSttTtft,
  observeSttTtfc,
  observeSttLatency,
  recordSttSession,
  recordSttFallback,
  sendMetrics,
  register: client.register
};
