#!/usr/bin/env node
/**
 * Lightweight harness that stress-tests the segment processor merge and caching behaviour.
 * Also provides a --lint-check flag used by package scripts to run quick syntax checks.
 */

const { spawnSync } = require('child_process');
const assert = require('assert/strict');
const process = require('process');

const { SegmentProcessor } = require('../server/segment-processor');

const FILES_TO_CHECK = [
  'server/index.js',
  'server/segment-processor.js',
  'server/translator.js',
  'server/tts.js',
  'server/watchdog.js',
  'scripts/wav-harness.js',
  'scripts/patch-fuzzer.js'
];

const noopLogger = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
  debug() {}
};

async function runLintCheck() {
  let exitCode = 0;
  for (const file of FILES_TO_CHECK) {
    const result = spawnSync(process.execPath, ['--check', file], {
      stdio: 'inherit'
    });
    if (result.status !== 0) {
      exitCode = result.status || 1;
    }
  }
  process.exit(exitCode);
}

async function runFuzz(iterations = 25) {
  let translateCalls = 0;
  const translator = {
    async translate(roomId, text, _fromLang, targetLangs) {
      translateCalls += 1;
      return targetLangs.map((lang) => ({
        lang,
        text: `[${lang}] ${text}`,
        srcSentLen: [text.length],
        transSentLen: [text.length + 4]
      }));
    }
  };
  const metrics = {
    observePatch() {}
  };
  const processor = new SegmentProcessor({
    roomId: 'fuzz',
    logger: noopLogger,
    translator,
    metrics
  });

  const baseText = [
    'Hello there',
    'How are you doing today',
    'Azure brings speech to life',
    'Streaming captions with replace in place works well'
  ];

  for (let i = 0; i < iterations; i += 1) {
    const text = baseText[i % baseText.length];
    const unitId = `sess|en-US|${i}`;
    const soft = await processor.processPatch(
      {
        unitId,
        stage: 'soft',
        op: 'replace',
        version: 1,
        text,
        srcLang: 'en-US'
      },
      ['fr-FR', 'es-ES']
    );
    assert.equal(soft.stale, false);
    assert.equal(soft.sourcePatch.text, text);
    assert.equal(soft.sourcePatch.stage, 'soft');
    assert.equal(soft.translatedPatches.length, 2);

    const stale = await processor.processPatch(
      {
        unitId,
        stage: 'soft',
        op: 'replace',
        version: 1,
        text: `${text} (stale)`,
        srcLang: 'en-US'
      },
      ['fr-FR']
    );
    assert.equal(stale.stale, true);

    const hard = await processor.processPatch(
      {
        unitId,
        stage: 'hard',
        op: 'replace',
        version: 2,
        text: `${text}!`,
        srcLang: 'en-US'
      },
      ['fr-FR']
    );
    assert.equal(hard.stale, false);
    assert.equal(hard.sourcePatch.stage, 'hard');

    const snapshot = await processor.snapshot('fr-FR');
    assert.ok(snapshot.length >= 1);
  }

  assert.ok(translateCalls >= iterations * 2, 'Translator should have been invoked.');
  console.log(`Fuzzed ${iterations} units successfully.`);
}

async function main() {
  if (process.argv.includes('--lint-check')) {
    await runLintCheck();
    return;
  }

  const iterationFlagIndex = process.argv.findIndex((arg) => arg === '--iterations');
  const iterations =
    iterationFlagIndex > -1 && process.argv[iterationFlagIndex + 1]
      ? Number(process.argv[iterationFlagIndex + 1])
      : 25;

  await runFuzz(iterations);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
