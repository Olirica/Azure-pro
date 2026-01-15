/**
 * Zoom RTMS Integration Unit Tests
 *
 * Tests webhook validation, patch mapping, and session management.
 */

const {
  computeWebhookValidation,
  verifyWebhookSignature,
  transcriptToPatch,
  handleWebhook
} = require('../server/zoom-rtms');

console.log('=== Zoom RTMS Integration Tests ===\n');

// Mock logger for tests
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

const mockDeps = {
  logger: mockLogger,
  ensureRoom: () => ({ ready: null, clients: new Set() }),
  broadcastPatch: async () => {},
  roomRegistry: { get: async () => null },
  defaultRoomTargets: () => new Set()
};

// Test 1: URL Validation HMAC
console.log('Test 1: URL validation HMAC computation');
// Note: This test only works if ZOOM_SECRET_TOKEN is set
const testToken = 'test-plain-token';
const encrypted = computeWebhookValidation(testToken);
console.log('  Input plainToken:', testToken);
console.log('  Output encryptedToken:', encrypted.substring(0, 20) + '...');
console.log('  ✓ Returns hex string of length 64:', encrypted.length === 64 ? 'PASS' : 'FAIL');
console.log();

// Test 2: Webhook URL validation event
console.log('Test 2: Webhook URL validation event handling');
const validationPayload = {
  event: 'endpoint.url_validation',
  payload: { plainToken: 'abc123' }
};
const validationResult = handleWebhook(validationPayload, mockDeps);
console.log('  Event:', validationPayload.event);
console.log('  Response status:', validationResult?.status);
// When ZOOM_SECRET_TOKEN is not set, returns 500 (correct behavior)
// When set, returns 200 with tokens
const isConfigured = process.env.ZOOM_SECRET_TOKEN;
if (isConfigured) {
  console.log('  Has plainToken:', !!validationResult?.body?.plainToken);
  console.log('  Has encryptedToken:', !!validationResult?.body?.encryptedToken);
  console.log('  ✓ Returns 200 with tokens:', validationResult?.status === 200 ? 'PASS' : 'FAIL');
} else {
  console.log('  ZOOM_SECRET_TOKEN not set - returns 500 (expected)');
  console.log('  ✓ Returns 500 when unconfigured:', validationResult?.status === 500 ? 'PASS' : 'FAIL');
}
console.log();

// Test 3: Transcript to patch mapping (no roomSourceLang - srcLang omitted)
console.log('Test 3: Transcript to patch mapping (srcLang omitted when no roomSourceLang)');
const mockSession = {
  meetingUuid: 'test-meeting-123',
  patchCounter: new Map()
};
const transcriptMsg = {
  msg_type: 'MEDIA_DATA_TRANSCRIPT',
  content: {
    user_id: 42,
    data: 'Hello, this is a test transcript.',
    timestamp: 1700000000000
  }
};
const patch = transcriptToPatch(mockSession, transcriptMsg);
console.log('  Input user_id:', transcriptMsg.content.user_id);
console.log('  Input text:', transcriptMsg.content.data);
console.log('  Output patch:');
console.log('    unitId:', patch.unitId);
console.log('    version:', patch.version);
console.log('    stage:', patch.stage);
console.log('    srcLang:', patch.srcLang, '(should be undefined)');
console.log('    ttsFinal:', patch.ttsFinal);
const unitIdValid = patch.unitId.includes('zoom-test-meeting-123-u42|und|1'); // "und" for undetermined
const versionValid = patch.version === 1;
const stageValid = patch.stage === 'hard';
const srcLangOmitted = patch.srcLang === undefined; // srcLang should be omitted, never "auto"
const ttsFinalValid = patch.ttsFinal === true; // ends with period
console.log('  ✓ unitId format with "und":', unitIdValid ? 'PASS' : 'FAIL');
console.log('  ✓ version is always 1:', versionValid ? 'PASS' : 'FAIL');
console.log('  ✓ stage is hard:', stageValid ? 'PASS' : 'FAIL');
console.log('  ✓ srcLang is undefined (not "auto"):', srcLangOmitted ? 'PASS' : 'FAIL');
console.log('  ✓ ttsFinal (ends with .):', ttsFinalValid ? 'PASS' : 'FAIL');
console.log();

// Test 4: Counter increments in unitId, version is always 1
console.log('Test 4: Counter increments in unitId (version is always 1)');
const patch2 = transcriptToPatch(mockSession, {
  content: { user_id: 42, data: 'Second message', timestamp: 1700000001000 }
});
const patch3 = transcriptToPatch(mockSession, {
  content: { user_id: 99, data: 'Different user', timestamp: 1700000002000 }
});
console.log('  User 42 second patch unitId:', patch2.unitId);
console.log('  User 42 second patch version:', patch2.version, '(always 1)');
console.log('  User 99 first patch unitId:', patch3.unitId);
console.log('  User 99 first patch version:', patch3.version, '(always 1)');
const user42CounterInUnitId = patch2.unitId.includes('|2'); // counter 2 in unitId
const user99CounterInUnitId = patch3.unitId.includes('|1'); // counter 1 in unitId
console.log('  ✓ User 42 counter=2 in unitId:', user42CounterInUnitId ? 'PASS' : 'FAIL');
console.log('  ✓ User 99 counter=1 in unitId:', user99CounterInUnitId ? 'PASS' : 'FAIL');
console.log('  ✓ Both versions are 1:', patch2.version === 1 && patch3.version === 1 ? 'PASS' : 'FAIL');
console.log();

// Test 5: Empty text returns null
console.log('Test 5: Empty text returns null patch');
const emptyPatch = transcriptToPatch(mockSession, {
  content: { user_id: 1, data: '   ', timestamp: 1700000000000 }
});
console.log('  Input text: "   " (whitespace only)');
console.log('  Output:', emptyPatch);
console.log('  ✓ Returns null for empty text:', emptyPatch === null ? 'PASS' : 'FAIL');
console.log();

// Test 6: Meeting started event handling
console.log('Test 6: Meeting started event (both event name variants)');
const startedPayload1 = {
  event: 'meeting.rtms.started',
  payload: {
    meeting_uuid: 'uuid-1',
    rtms_stream_id: 'stream-1',
    server_urls: ['wss://example.com/ws']
  }
};
const startedPayload2 = {
  event: 'meeting.rtms_started', // underscore variant
  payload: {
    meeting_uuid: 'uuid-2',
    rtms_stream_id: 'stream-2',
    server_urls: ['wss://example.com/ws']
  }
};
// Note: These will fail to actually connect (no real server), but should return 200
const result1 = handleWebhook(startedPayload1, mockDeps);
const result2 = handleWebhook(startedPayload2, mockDeps);
console.log('  Event "meeting.rtms.started" status:', result1?.status);
console.log('  Event "meeting.rtms_started" status:', result2?.status);
console.log('  ✓ Dot variant returns 200:', result1?.status === 200 ? 'PASS' : 'FAIL');
console.log('  ✓ Underscore variant returns 200:', result2?.status === 200 ? 'PASS' : 'FAIL');
console.log();

// Test 7: ttsFinal detection (true when terminal punct, OMITTED otherwise - never false)
console.log('Test 7: ttsFinal detection (only set true, omitted otherwise)');
const testCases = [
  { text: 'Hello world.', expected: true },
  { text: 'Is this working?', expected: true },
  { text: 'Wow!', expected: true },
  { text: 'Incomplete sentence', expected: undefined }, // IMPORTANT: undefined, not false
  { text: 'Trailing comma,', expected: undefined }      // IMPORTANT: undefined, not false
];
let allPass = true;
for (const tc of testCases) {
  const p = transcriptToPatch({ meetingUuid: 'test', patchCounter: new Map() }, {
    content: { user_id: 1, data: tc.text, timestamp: Date.now() }
  });
  const pass = p.ttsFinal === tc.expected;
  if (!pass) allPass = false;
  console.log(`  "${tc.text}" → ttsFinal=${p.ttsFinal} (expected ${tc.expected}): ${pass ? 'PASS' : 'FAIL'}`);
}
console.log('  ✓ All punctuation tests:', allPass ? 'PASS' : 'FAIL');
console.log();

// Test 8: srcLang with roomSourceLang parameter
console.log('Test 8: srcLang uses roomSourceLang when provided');
const patchWithLang = transcriptToPatch(
  { meetingUuid: 'test', patchCounter: new Map() },
  { content: { user_id: 1, data: 'Bonjour', timestamp: Date.now() } },
  'fr-CA' // roomSourceLang
);
console.log('  roomSourceLang: fr-CA');
console.log('  patch.srcLang:', patchWithLang.srcLang);
console.log('  patch.unitId:', patchWithLang.unitId);
const srcLangSet = patchWithLang.srcLang === 'fr-CA';
const unitIdHasLang = patchWithLang.unitId.includes('|fr-CA|');
console.log('  ✓ srcLang is fr-CA:', srcLangSet ? 'PASS' : 'FAIL');
console.log('  ✓ unitId contains fr-CA:', unitIdHasLang ? 'PASS' : 'FAIL');
console.log();

// Test 9: srcLang "auto" is treated as undefined
console.log('Test 9: srcLang "auto" is treated as undefined (never sent)');
const patchWithAuto = transcriptToPatch(
  { meetingUuid: 'test', patchCounter: new Map() },
  { content: { user_id: 1, data: 'Hello', timestamp: Date.now() } },
  'auto' // roomSourceLang = "auto" should be treated as undefined
);
console.log('  roomSourceLang: "auto"');
console.log('  patch.srcLang:', patchWithAuto.srcLang, '(should be undefined)');
const autoTreatedAsUndefined = patchWithAuto.srcLang === undefined;
console.log('  ✓ srcLang is undefined (not "auto"):', autoTreatedAsUndefined ? 'PASS' : 'FAIL');
console.log();

console.log('=== Tests Complete ===');
