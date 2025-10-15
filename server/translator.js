const axios = require('axios');

const DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';
const PROFANITY_ACTION = process.env.TRANSLATOR_PROFANITY_ACTION;
const PROFANITY_MARKER = process.env.TRANSLATOR_PROFANITY_MARKER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini';
const OPENAI_TRANSLATE_ENDPOINT =
  process.env.OPENAI_TRANSLATE_ENDPOINT || 'https://api.openai.com/v1/chat/completions';

function splitSentences(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return [];
  }
  const matches = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  if (!matches) {
    return [trimmed];
  }
  return matches.map((segment) => segment.trim()).filter(Boolean);
}

function charLengthsForSentences(sentences, originalText) {
  if (!Array.isArray(sentences) || !sentences.length) {
    const fallback = (originalText || '').trim();
    return fallback ? [fallback.length] : [];
  }
  return sentences.map((sentence) => sentence.length);
}

async function translateWithOpenAI({ roomId, text, fromLang, targetLangs, logger, metrics }) {
  if (!OPENAI_API_KEY || !targetLangs.length) {
    return null;
  }
  const sourceSentences = splitSentences(text);
  const srcLengths = charLengthsForSentences(sourceSentences, text);
  const translations = [];

  for (const lang of targetLangs) {
    try {
      const response = await axios.post(
        OPENAI_TRANSLATE_ENDPOINT,
        {
          model: OPENAI_TRANSLATE_MODEL,
          messages: [
            {
              role: 'system',
              content: `You are a translation engine. Translate the user's message from ${
                fromLang || 'the source language'
              } to ${lang}. Preserve sentence order and keep the output concise.`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      const translatedText = response?.data?.choices?.[0]?.message?.content?.trim();
      if (!translatedText) {
        throw new Error('OpenAI translation returned empty content');
      }
      const targetSentences = splitSentences(translatedText);
      const tgtLengths = charLengthsForSentences(targetSentences, translatedText);
      metrics?.observeTranslator?.(roomId, lang, 'fallback_openai');
      translations.push({
        lang,
        text: translatedText,
        srcSentLen: srcLengths,
        transSentLen: tgtLengths,
        fallback: 'openai'
      });
    } catch (err) {
      logger?.warn(
        { component: 'translator', roomId, lang, err: err?.response?.data || err?.message },
        'OpenAI fallback translation failed.'
      );
    }
  }

  return translations.length ? translations : null;
}

/**
 * Build a translator helper that wraps Azure Translator Text API v3 with
 * includeSentenceLength=true so callers receive deterministic sentence spans.
 * Falls back to a no-op translator when credentials are missing.
 * @param {Object} deps
 * @param {import('pino').Logger} deps.logger
 * @param {Object} deps.metrics
 * @param {(roomId: string, lang: string, seconds: number) => void} [deps.observeLatency]
 * @returns {{ translate: (roomId: string, text: string, fromLang: string | undefined, targetLangs: string[]) => Promise<Array<{ lang: string, text: string, srcSentLen: number[], transSentLen: number[] }>> }}
 */
function createTranslator({ logger, metrics, observeLatency }) {
  const key = process.env.TRANSLATOR_KEY;
  const region = process.env.TRANSLATOR_REGION || 'global';
  const endpoint = (process.env.TRANSLATOR_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/, '');

  if (!key) {
    logger.warn(
      { component: 'translator' },
      'TRANSLATOR_KEY missing – translator will fall back to identity (no-op) behaviour.'
    );
    return {
      async translate(roomId, text, _fromLang, targetLangs) {
        const trimmed = (text || '').trim();
        if (!trimmed) {
          return [];
        }
        return targetLangs.map((lang) => {
          metrics?.observeTranslator?.(roomId, lang, 'missing_key');
          return {
            lang,
            text: trimmed,
            srcSentLen: [trimmed.length],
            transSentLen: [trimmed.length],
            isNoop: true
          };
        });
      }
    };
  }

  const headers = {
    'Ocp-Apim-Subscription-Key': key,
    'Ocp-Apim-Subscription-Region': region,
    'Content-Type': 'application/json'
  };

  return {
    /**
     * Translate the supplied text to the requested set of languages.
     * @param {string} roomId
     * @param {string} text
     * @param {string | undefined} fromLang
     * @param {string[]} targetLangs
     * @returns {Promise<Array<{ lang: string, text: string, srcSentLen: number[], transSentLen: number[] }>>}
     */
    async translate(roomId, text, fromLang, targetLangs) {
      const trimmed = (text || '').trim();
      if (!trimmed || !targetLangs.length) {
        return [];
      }

      const params = new URLSearchParams({
        'api-version': '3.0',
        includeSentenceLength: 'true'
      });

      if (fromLang) {
        params.set('from', fromLang);
      }

      if (PROFANITY_ACTION) {
        params.set('profanityAction', PROFANITY_ACTION);
      }
      if (PROFANITY_MARKER) {
        params.set('profanityMarker', PROFANITY_MARKER);
      }

      for (const lang of targetLangs) {
        params.append('to', lang);
      }

      const url = `${endpoint}/translate?${params.toString()}`;
      const payload = [{ text: trimmed }];

      const start = process.hrtime.bigint();
      try {
        const { data } = await axios.post(url, payload, { headers, timeout: 10000 });
        const elapsedNs = Number(process.hrtime.bigint() - start);
        const elapsedSeconds = elapsedNs / 1e9;
        if (typeof observeLatency === 'function') {
          for (const lang of targetLangs) {
            observeLatency(roomId, lang, elapsedSeconds);
          }
        } else if (metrics?.observeTranslationLatency) {
          for (const lang of targetLangs) {
            metrics.observeTranslationLatency(roomId, lang, elapsedSeconds);
          }
        }

        const entry = Array.isArray(data) ? data[0] : undefined;
        const targetMap = new Map();
        for (const lang of targetLangs) {
          const lower = lang.toLowerCase();
          targetMap.set(lower, lang);
          const base = lower.split('-')[0];
          if (!targetMap.has(base)) {
            targetMap.set(base, lang);
          }
        }
        if (!entry || !Array.isArray(entry.translations)) {
          logger.warn(
            { component: 'translator', roomId, data },
            'Unexpected translator response structure.'
          );
          metrics?.observeTranslator?.(roomId, 'unknown', 'malformed');
          return [];
        }

        return entry.translations
          .map((translation) => {
            const toLower = (translation.to || '').toLowerCase();
            const mappedLang = targetMap.get(toLower) || translation.to || targetLangs[0];
            const sentLen = translation.sentLen || {};
            metrics?.observeTranslator?.(roomId, mappedLang, 'ok');
            return {
              lang: mappedLang,
              text: translation.text || '',
              srcSentLen: Array.isArray(sentLen.srcSentLen) ? sentLen.srcSentLen : [],
              transSentLen: Array.isArray(sentLen.transSentLen) ? sentLen.transSentLen : []
            };
          })
          .filter((translation) => Boolean(translation.lang));
      } catch (err) {
        const elapsedNsErr = Number(process.hrtime.bigint() - start);
        const elapsedSecondsErr = elapsedNsErr / 1e9;
        logger.error(
          { component: 'translator', roomId, err: err?.response?.data || err?.message },
          'Translator request failed.'
        );
        if (typeof observeLatency === 'function') {
          for (const lang of targetLangs) {
            observeLatency(roomId, lang, elapsedSecondsErr);
          }
        } else if (metrics?.observeTranslationLatency) {
          for (const lang of targetLangs) {
            metrics.observeTranslationLatency(roomId, lang, elapsedSecondsErr);
          }
        }
        const outcome =
          err?.response?.status && err.response.status >= 500 ? 'server_error' : 'error';
        for (const lang of targetLangs) {
          metrics?.observeTranslator?.(roomId, lang, outcome);
        }

        const fallbackTranslations = await translateWithOpenAI({
          roomId,
          text: trimmed,
          fromLang,
          targetLangs,
          logger,
          metrics
        });
        if (fallbackTranslations) {
          return fallbackTranslations;
        }

        return targetLangs.map((lang) => ({
          lang,
          text: trimmed,
          srcSentLen: [trimmed.length],
          transSentLen: [trimmed.length],
          error: true
        }));
      }
    }
  };
}

module.exports = {
  createTranslator
};
