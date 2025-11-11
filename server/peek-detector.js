/**
 * Gender marker detection for backward peek translation correction.
 *
 * Detects gender markers in new segments to enable re-translation of
 * previous segments with ambiguous pronouns (they/their/them).
 *
 * Strategy: Simple regex-based detection (no LLM needed)
 * - Fast (<5ms)
 * - No API costs
 * - High precision for common cases
 */

// Gender marker patterns by language
const GENDER_MARKERS = {
  en: {
    female: [
      // Titles
      /\b(?:Mrs?s?|Ms|Miss|Madam|Ma'am)\b\.?\s+\w+/gi,
      // Pronouns (strong indicators)
      /\b(?:she|her|hers|herself)\b/gi,
      // Possessive with female context
      /\b(?:her)\s+(?:name|voice|decision|recommendation)/gi,
      // Professional titles with female indicators
      /\b(?:actress|waitress|stewardess|businesswoman|spokeswoman)\b/gi
    ],
    male: [
      // Titles
      /\b(?:Mr|Mister|Sir)\b\.?\s+\w+/gi,
      // Pronouns (strong indicators)
      /\b(?:he|him|his|himself)\b/gi,
      // Possessive with male context
      /\b(?:his)\s+(?:name|voice|decision|recommendation)/gi,
      // Professional titles with male indicators
      /\b(?:actor|waiter|steward|businessman|spokesman)\b/gi
    ]
  },
  fr: {
    female: [
      // Titles
      /\b(?:Madame|Mme|Mlle|Mademoiselle)\b\.?\s+\w+/gi,
      // Pronouns
      /\b(?:elle|la)\b/gi,
      // Possessive
      /\b(?:sa|ses)\s+(?:nom|voix|décision|recommandation)/gi,
      // Articles with female nouns
      /\b(?:une|la)\s+(?:femme|dame|fille|actrice)/gi
    ],
    male: [
      // Titles
      /\b(?:Monsieur|M\.|Mr)\b\.?\s+\w+/gi,
      // Pronouns
      /\b(?:il|le)\b/gi,
      // Possessive
      /\b(?:son|ses)\s+(?:nom|voix|décision|recommandation)/gi,
      // Articles with male nouns
      /\b(?:un|le)\s+(?:homme|monsieur|garçon|acteur)/gi
    ]
  }
};

// Ambiguous pronouns that trigger backward peek
const AMBIGUOUS_PRONOUNS = {
  en: /\b(?:they|them|their|theirs|themselves)\b/gi,
  fr: /\b(?:ils|elles|leur|leurs)\b/gi
};

/**
 * Detect gender markers in text.
 * @param {string} text - Text to analyze
 * @param {string} lang - Language code (en, fr, etc.)
 * @returns {{ gender: 'male'|'female'|null, confidence: number, markers: string[] }}
 */
function detectGender(text, lang = 'en') {
  if (!text) {
    return { gender: null, confidence: 0, markers: [] };
  }

  // Get language-specific patterns (fallback to English)
  const baseLang = lang.split('-')[0]; // en-CA → en
  const patterns = GENDER_MARKERS[baseLang] || GENDER_MARKERS.en;

  const femaleMarkers = [];
  const maleMarkers = [];

  // Check female patterns
  for (const pattern of patterns.female) {
    const matches = text.match(pattern);
    if (matches) {
      femaleMarkers.push(...matches);
    }
  }

  // Check male patterns
  for (const pattern of patterns.male) {
    const matches = text.match(pattern);
    if (matches) {
      maleMarkers.push(...matches);
    }
  }

  // Determine gender based on marker counts
  const femaleCount = femaleMarkers.length;
  const maleCount = maleMarkers.length;

  if (femaleCount === 0 && maleCount === 0) {
    return { gender: null, confidence: 0, markers: [] };
  }

  if (femaleCount > maleCount) {
    const confidence = femaleCount / (femaleCount + maleCount);
    return { gender: 'female', confidence, markers: femaleMarkers };
  }

  if (maleCount > femaleCount) {
    const confidence = maleCount / (femaleCount + maleCount);
    return { gender: 'male', confidence, markers: maleMarkers };
  }

  // Equal counts - ambiguous, prefer null
  return { gender: null, confidence: 0.5, markers: [...femaleMarkers, ...maleMarkers] };
}

/**
 * Check if text contains ambiguous pronouns that could benefit from gender context.
 * @param {string} text - Text to check
 * @param {string} lang - Language code
 * @returns {boolean}
 */
function hasAmbiguousPronouns(text, lang = 'en') {
  if (!text) {
    return false;
  }

  const baseLang = lang.split('-')[0];
  const pattern = AMBIGUOUS_PRONOUNS[baseLang] || AMBIGUOUS_PRONOUNS.en;

  return pattern.test(text);
}

/**
 * Determine if a backward peek should be performed.
 * @param {Object} newSegment - New segment with potential gender markers
 * @param {Object} previousSegment - Previous segment to potentially revise
 * @returns {{ shouldPeek: boolean, gender: 'male'|'female'|null, confidence: number, reason: string }}
 */
function shouldPerformBackwardPeek(newSegment, previousSegment) {
  if (!newSegment || !previousSegment) {
    return { shouldPeek: false, gender: null, confidence: 0, reason: 'missing_segments' };
  }

  const { text: newText, srcLang = 'en' } = newSegment;
  const { text: prevText, srcLang: prevLang = 'en' } = previousSegment;

  // Only peek if languages match
  if (srcLang !== prevLang) {
    return { shouldPeek: false, gender: null, confidence: 0, reason: 'language_mismatch' };
  }

  // Check if new segment has gender markers
  const genderDetection = detectGender(newText, srcLang);

  if (!genderDetection.gender || genderDetection.confidence < 0.7) {
    return {
      shouldPeek: false,
      gender: genderDetection.gender,
      confidence: genderDetection.confidence,
      reason: 'no_strong_gender_marker'
    };
  }

  // Check if previous segment has ambiguous pronouns
  if (!hasAmbiguousPronouns(prevText, srcLang)) {
    return {
      shouldPeek: false,
      gender: genderDetection.gender,
      confidence: genderDetection.confidence,
      reason: 'no_ambiguous_pronouns'
    };
  }

  // All conditions met - perform backward peek
  return {
    shouldPeek: true,
    gender: genderDetection.gender,
    confidence: genderDetection.confidence,
    reason: 'gender_correction_needed',
    markers: genderDetection.markers
  };
}

module.exports = {
  detectGender,
  hasAmbiguousPronouns,
  shouldPerformBackwardPeek
};
