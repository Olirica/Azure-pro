/**
 * Zoom RTMS Integration
 *
 * Handles Zoom Realtime Media Streams (RTMS) for transcript ingestion.
 * Converts Zoom transcript events into Simo patches for translation.
 */

const crypto = require('crypto');
const WS = require('ws');

const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || '';
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || '';
const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN || '';

const MAX_KEEPALIVE_MISSES = 3;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 3;

// Active sessions keyed by meeting_uuid
const sessions = new Map();

/**
 * Compute HMAC-SHA256 signature for Zoom RTMS handshake.
 * @param {string} message - Message to sign (client_id + meeting_uuid + rtms_stream_id)
 * @param {string} secret - Client secret
 * @returns {string} Hex-encoded signature
 */
function computeSignature(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Compute URL validation HMAC for Zoom webhook.
 * @param {string} plainToken - Token from Zoom
 * @returns {string} Hex-encoded encrypted token
 */
function computeWebhookValidation(plainToken) {
  return crypto.createHmac('sha256', ZOOM_SECRET_TOKEN).update(plainToken).digest('hex');
}

/**
 * Verify Zoom webhook request signature.
 * Zoom sends x-zm-signature and x-zm-request-timestamp headers.
 * @param {object} req - Express request object (needs headers and body)
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature(req) {
  if (!ZOOM_SECRET_TOKEN) return false;

  const timestamp = req.headers['x-zm-request-timestamp'];
  const signature = req.headers['x-zm-signature'];

  if (!timestamp || !signature) return false;

  // Zoom signature format: v0=HMAC-SHA256(secret, "v0:{timestamp}:{body}")
  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const expected = 'v0=' + crypto.createHmac('sha256', ZOOM_SECRET_TOKEN)
    .update(message).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Create a new session object for a Zoom meeting.
 */
function createSession(meetingUuid, rtmsStreamId, serverUrls) {
  return {
    meetingUuid,
    rtmsStreamId,
    serverUrls,
    roomId: `zoom-${meetingUuid.toLowerCase().replace(/[^a-z0-9-]/g, '')}`,
    signalingWs: null,
    transcriptWs: null,
    keepAliveTimer: null,
    missedKeepAlives: 0,
    patchCounter: new Map(), // user_id -> counter
    state: 'idle', // idle | connecting_signaling | connecting_transcript | streaming | disconnected
    reconnectAttempts: 0,
    serverUrlIndex: 0
  };
}

/**
 * Convert Zoom transcript message to Simo patch format.
 * @param {object} session - RTMS session
 * @param {object} msg - Transcript message from Zoom
 * @param {string|undefined} roomSourceLang - Room's fixed source language (if pre-configured)
 */
function transcriptToPatch(session, msg, roomSourceLang) {
  const content = msg.content || msg;
  const userId = content.user_id ?? 0;
  const text = content.data || '';
  const timestamp = content.timestamp || Date.now();

  if (!text || !text.trim()) {
    return null;
  }

  // Increment counter per Zoom user
  const counter = (session.patchCounter.get(userId) || 0) + 1;
  session.patchCounter.set(userId, counter);

  // srcLang: use room's fixed sourceLang, or omit to let Azure/OpenAI infer
  // IMPORTANT: never send "auto" - Azure Translator rejects from=auto
  const srcLang = roomSourceLang && roomSourceLang !== 'auto' ? roomSourceLang : undefined;
  const srcLangForUnitId = srcLang || 'und'; // "und" = undetermined (BCP-47)

  const patch = {
    unitId: `zoom-${session.meetingUuid}-u${userId}|${srcLangForUnitId}|${counter}`,
    version: 1, // Always 1 - each transcript is a new unit (counter is in unitId)
    stage: 'hard',
    op: 'replace',
    text: text.trim(),
    ts: timestamp
  };

  // Only include srcLang if known (omit lets translator auto-detect)
  if (srcLang) patch.srcLang = srcLang;

  // ttsFinal: only set true when confident (terminal punctuation)
  // IMPORTANT: don't set false - that blocks TTS entirely. Omit instead.
  if (/[.?!]\s*$/.test(text)) patch.ttsFinal = true;

  return patch;
}

/**
 * Start RTMS session - connects signaling WebSocket.
 */
function startSession(meetingUuid, rtmsStreamId, serverUrls, deps) {
  const { logger, ensureRoom, broadcastPatch, roomRegistry, defaultRoomTargets } = deps;

  if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    logger.error({ component: 'zoom-rtms' }, 'Missing ZOOM_CLIENT_ID or ZOOM_CLIENT_SECRET');
    return null;
  }

  if (sessions.has(meetingUuid)) {
    logger.warn({ component: 'zoom-rtms', meetingUuid }, 'Session already exists');
    return sessions.get(meetingUuid);
  }

  const session = createSession(meetingUuid, rtmsStreamId, serverUrls);
  sessions.set(meetingUuid, session);

  logger.info({ component: 'zoom-rtms', meetingUuid, roomId: session.roomId }, 'Starting RTMS session');

  connectSignaling(session, deps);
  return session;
}

/**
 * Connect to signaling WebSocket.
 */
function connectSignaling(session, deps) {
  const { logger } = deps;

  if (session.serverUrlIndex >= session.serverUrls.length) {
    logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'No more server URLs to try');
    session.state = 'disconnected';
    return;
  }

  const url = session.serverUrls[session.serverUrlIndex];
  session.state = 'connecting_signaling';

  logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, url }, 'Connecting to signaling');

  const ws = new WS(url);
  session.signalingWs = ws;

  ws.on('open', () => {
    logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Signaling connected, sending handshake');

    // Comma-delimited signature per Zoom RTMS SDK
    const message = `${ZOOM_CLIENT_ID},${session.meetingUuid},${session.rtmsStreamId}`;
    const signature = computeSignature(message, ZOOM_CLIENT_SECRET);

    ws.send(JSON.stringify({
      msg_type: 'SIGNALING_HAND_SHAKE_REQ',
      protocol_version: 1,
      meeting_uuid: session.meetingUuid,
      rtms_stream_id: session.rtmsStreamId,
      signature
    }));
  });

  ws.on('message', (data) => {
    handleSignalingMessage(session, data, deps);
  });

  ws.on('close', (code) => {
    logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, code }, 'Signaling closed');
    if (session.state !== 'disconnected') {
      handleReconnect(session, deps);
    }
  });

  ws.on('error', (err) => {
    logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, err: err?.message }, 'Signaling error');
  });
}

/**
 * Handle messages from signaling WebSocket.
 */
function handleSignalingMessage(session, data, deps) {
  const { logger } = deps;

  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    logger.warn({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Invalid signaling JSON');
    return;
  }

  const msgType = msg.msg_type;

  if (msgType === 'SIGNALING_HAND_SHAKE_RESP') {
    if (msg.status === 'OK') {
      logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Signaling handshake OK');
      session.missedKeepAlives = 0;

      // Extract transcript URL and connect
      const transcriptUrl = msg.media_urls?.transcript;
      if (transcriptUrl) {
        connectTranscript(session, transcriptUrl, deps);
      } else {
        logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'No transcript URL in handshake response');
      }
    } else {
      // Signature format is fixed (comma-delimited) - don't retry, just log and cleanup
      logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, status: msg.status }, 'Signaling handshake failed');
      session.state = 'disconnected';
      try { session.signalingWs.close(); } catch {}
    }
  } else if (msgType === 'KEEP_ALIVE_REQ') {
    // Respond to keep-alive
    session.missedKeepAlives = 0;
    session.signalingWs.send(JSON.stringify({
      msg_type: 'KEEP_ALIVE_RESP',
      timestamp: msg.timestamp
    }));
  } else {
    logger.debug({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, msgType }, 'Unknown signaling message');
  }
}

/**
 * Connect to transcript WebSocket.
 */
function connectTranscript(session, url, deps) {
  const { logger } = deps;

  session.state = 'connecting_transcript';
  logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, url }, 'Connecting to transcript');

  const ws = new WS(url);
  session.transcriptWs = ws;

  ws.on('open', () => {
    logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Transcript connected, sending handshake');

    // Comma-delimited signature per Zoom RTMS SDK
    const message = `${ZOOM_CLIENT_ID},${session.meetingUuid},${session.rtmsStreamId}`;
    const signature = computeSignature(message, ZOOM_CLIENT_SECRET);

    ws.send(JSON.stringify({
      msg_type: 'DATA_HAND_SHAKE_REQ',
      protocol_version: 1,
      meeting_uuid: session.meetingUuid,
      rtms_stream_id: session.rtmsStreamId,
      signature,
      payload_encryption: false
    }));
  });

  ws.on('message', (data) => {
    handleTranscriptMessage(session, data, deps);
  });

  ws.on('close', (code) => {
    logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, code }, 'Transcript closed');
    if (session.state === 'streaming') {
      session.state = 'disconnected';
    }
  });

  ws.on('error', (err) => {
    logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, err: err?.message }, 'Transcript error');
  });
}

/**
 * Handle messages from transcript WebSocket.
 */
async function handleTranscriptMessage(session, data, deps) {
  const { logger, ensureRoom, broadcastPatch, roomRegistry, defaultRoomTargets } = deps;

  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    logger.warn({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Invalid transcript JSON');
    return;
  }

  const msgType = msg.msg_type;

  if (msgType === 'DATA_HAND_SHAKE_RESP') {
    if (msg.status === 'OK') {
      logger.info({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Transcript handshake OK, streaming');
      session.state = 'streaming';
      session.reconnectAttempts = 0;
    } else {
      logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, status: msg.status }, 'Transcript handshake failed');
    }
  } else if (msgType === 'MEDIA_DATA_TRANSCRIPT') {
    // Get room metadata for sourceLang and targetLangs
    let roomSourceLang;
    let roomDefaultTargets = [];
    try {
      const meta = await roomRegistry.get(session.roomId);
      if (meta) {
        roomSourceLang = meta.sourceLang;
        roomDefaultTargets = meta.defaultTargetLangs || [];
      }
    } catch {
      // Ignore - room may not be pre-configured
    }

    // Convert transcript to patch with room's sourceLang
    const patch = transcriptToPatch(session, msg, roomSourceLang);
    if (!patch) {
      return;
    }

    try {
      const room = ensureRoom(session.roomId);
      if (room.ready) {
        await room.ready;
      }

      // Collect target languages from connected listeners + room defaults
      const targetLangs = new Set(defaultRoomTargets(room));
      for (const t of roomDefaultTargets) {
        if (t && t !== 'source') targetLangs.add(t);
      }

      const result = await room.processor.processPatch(patch, Array.from(targetLangs));
      if (!result.stale) {
        await broadcastPatch(room, result);
        logger.debug({
          component: 'zoom-rtms',
          meetingUuid: session.meetingUuid,
          unitId: patch.unitId,
          text: patch.text.substring(0, 50)
        }, 'Patch broadcast');
      }
    } catch (err) {
      logger.error({
        component: 'zoom-rtms',
        meetingUuid: session.meetingUuid,
        err: err?.message
      }, 'Failed to process patch');
    }
  } else {
    logger.debug({ component: 'zoom-rtms', meetingUuid: session.meetingUuid, msgType }, 'Unknown transcript message');
  }
}

/**
 * Handle reconnection after disconnect.
 */
function handleReconnect(session, deps) {
  const { logger } = deps;

  if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error({ component: 'zoom-rtms', meetingUuid: session.meetingUuid }, 'Max reconnect attempts reached');
    session.state = 'disconnected';
    return;
  }

  session.reconnectAttempts++;
  session.serverUrlIndex++;

  if (session.serverUrlIndex >= session.serverUrls.length) {
    session.serverUrlIndex = 0; // Wrap around
  }

  logger.info({
    component: 'zoom-rtms',
    meetingUuid: session.meetingUuid,
    attempt: session.reconnectAttempts
  }, 'Reconnecting');

  setTimeout(() => {
    connectSignaling(session, deps);
  }, RECONNECT_DELAY_MS);
}

/**
 * Stop RTMS session and clean up.
 */
function stopSession(meetingUuid, deps) {
  const { logger } = deps;
  const session = sessions.get(meetingUuid);

  if (!session) {
    logger.warn({ component: 'zoom-rtms', meetingUuid }, 'No session to stop');
    return;
  }

  logger.info({ component: 'zoom-rtms', meetingUuid }, 'Stopping session');

  session.state = 'disconnected';

  if (session.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
    session.keepAliveTimer = null;
  }

  if (session.signalingWs) {
    try {
      session.signalingWs.close();
    } catch {}
    session.signalingWs = null;
  }

  if (session.transcriptWs) {
    try {
      session.transcriptWs.close();
    } catch {}
    session.transcriptWs = null;
  }

  sessions.delete(meetingUuid);
}

/**
 * Handle Zoom webhook request.
 * Returns response object or null if not handled.
 * @param {object} body - Request body
 * @param {object} deps - Dependencies
 * @param {object} req - Express request (optional, needed for signature verification)
 */
function handleWebhook(body, deps, req) {
  const { logger } = deps;
  const event = body.event;
  const payload = body.payload || {};

  // URL validation (no signature verification needed)
  if (event === 'endpoint.url_validation') {
    if (!ZOOM_SECRET_TOKEN) {
      logger.error({ component: 'zoom-rtms' }, 'ZOOM_SECRET_TOKEN not configured');
      return { status: 500, body: { error: 'Server misconfigured' } };
    }
    const plainToken = payload.plainToken;
    const encryptedToken = computeWebhookValidation(plainToken);
    return {
      status: 200,
      body: { plainToken, encryptedToken }
    };
  }

  // All other events: verify signature first (if request object provided)
  if (req && !verifyWebhookSignature(req)) {
    logger.warn({ component: 'zoom-rtms', event }, 'Invalid webhook signature');
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  // Meeting RTMS started (handle both event name variants)
  if (event === 'meeting.rtms.started' || event === 'meeting.rtms_started') {
    const { meeting_uuid, rtms_stream_id, server_urls } = payload;

    if (!meeting_uuid || !rtms_stream_id || !Array.isArray(server_urls) || !server_urls.length) {
      logger.warn({ component: 'zoom-rtms', event }, 'Invalid RTMS started payload');
      return { status: 400, body: { error: 'Invalid payload' } };
    }

    startSession(meeting_uuid, rtms_stream_id, server_urls, deps);
    return { status: 200, body: { ok: true } };
  }

  // Meeting RTMS stopped
  if (event === 'meeting.rtms.stopped' || event === 'meeting.rtms_stopped') {
    const { meeting_uuid } = payload;
    if (meeting_uuid) {
      stopSession(meeting_uuid, deps);
    }
    return { status: 200, body: { ok: true } };
  }

  // Unknown event - acknowledge but don't process
  logger.debug({ component: 'zoom-rtms', event }, 'Unhandled webhook event');
  return { status: 200, body: { ok: true, ignored: true } };
}

/**
 * Get active session for a meeting.
 */
function getSession(meetingUuid) {
  return sessions.get(meetingUuid) || null;
}

/**
 * Check if Zoom RTMS is configured.
 */
function isConfigured() {
  return Boolean(ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET && ZOOM_SECRET_TOKEN);
}

module.exports = {
  handleWebhook,
  startSession,
  stopSession,
  getSession,
  isConfigured,
  computeWebhookValidation,
  verifyWebhookSignature,
  transcriptToPatch
};
