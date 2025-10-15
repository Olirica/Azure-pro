/**
 * Lightweight watchdog that tracks activity from the Speech SDK and PCM ingest
 * so we only trigger a restart when both have been idle beyond their thresholds.
 * @param {Object} deps
 * @param {number} [deps.idleEventMs=6000]
 * @param {number} [deps.idlePcmMs=3500]
 * @param {import('pino').Logger} deps.logger
 */
function createWatchdog({ idleEventMs = 6000, idlePcmMs = 3500, logger }) {
  let lastEventAt = Date.now();
  let lastPcmAt = Date.now();

  function markEvent() {
    lastEventAt = Date.now();
  }

  function markPcm() {
    lastPcmAt = Date.now();
  }

  function getState() {
    const now = Date.now();
    return {
      eventIdleMs: now - lastEventAt,
      pcmIdleMs: now - lastPcmAt
    };
  }

  function shouldTriggerRestart() {
    const state = getState();
    const trigger = state.eventIdleMs > idleEventMs && state.pcmIdleMs > idlePcmMs;
    if (trigger) {
      logger?.warn(
        {
          component: 'watchdog',
          idleEventMs,
          idlePcmMs,
          ...state
        },
        'Watchdog conditions met, signalling restart.'
      );
    }
    return trigger;
  }

  return {
    markEvent,
    markPcm,
    shouldTriggerRestart,
    getState
  };
}

module.exports = {
  createWatchdog
};
