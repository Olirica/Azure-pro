/**
 * Word Error Rate (WER) calculation utilities.
 *
 * WER = (Substitutions + Deletions + Insertions) / Reference Words
 *
 * Uses Levenshtein distance at the word level.
 */

/**
 * Tokenize and normalize text for WER calculation.
 * - Lowercase
 * - Remove punctuation (keep apostrophes and hyphens within words)
 * - Collapse whitespace
 * - Split into words
 *
 * @param {string} text - Input text
 * @returns {string[]} Array of normalized tokens
 */
export function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')  // Keep letters, numbers, hyphens, apostrophes
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Compute Levenshtein distance matrix between two word sequences.
 * Returns the full edit distance matrix for analysis.
 *
 * @param {string[]} hyp - Hypothesis (ASR output) tokens
 * @param {string[]} ref - Reference (ground truth) tokens
 * @returns {{ distance: number, matrix: number[][] }}
 */
export function levenshteinMatrix(hyp, ref) {
  const m = hyp.length;
  const n = ref.length;

  // Create (m+1) x (n+1) matrix
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  // Base cases: transforming empty string
  for (let i = 0; i <= m; i++) dp[i][0] = i;  // Deletions
  for (let j = 0; j <= n; j++) dp[0][j] = j;  // Insertions

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (hyp[i - 1] === ref[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];  // Match
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],      // Deletion
          dp[i][j - 1],      // Insertion
          dp[i - 1][j - 1]   // Substitution
        );
      }
    }
  }

  return {
    distance: dp[m][n],
    matrix: dp,
  };
}

/**
 * Backtrace through the edit distance matrix to get detailed error counts.
 *
 * @param {string[]} hyp - Hypothesis tokens
 * @param {string[]} ref - Reference tokens
 * @param {number[][]} matrix - Edit distance matrix
 * @returns {{ substitutions: number, deletions: number, insertions: number }}
 */
export function backtraceErrors(hyp, ref, matrix) {
  let i = hyp.length;
  let j = ref.length;

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && hyp[i - 1] === ref[j - 1]) {
      // Match - move diagonally
      i--;
      j--;
    } else if (i > 0 && j > 0 && matrix[i][j] === matrix[i - 1][j - 1] + 1) {
      // Substitution
      substitutions++;
      i--;
      j--;
    } else if (i > 0 && matrix[i][j] === matrix[i - 1][j] + 1) {
      // Deletion (word in hyp not in ref)
      deletions++;
      i--;
    } else if (j > 0 && matrix[i][j] === matrix[i][j - 1] + 1) {
      // Insertion (word in ref not in hyp)
      insertions++;
      j--;
    } else {
      // Fallback (shouldn't happen with correct matrix)
      break;
    }
  }

  return { substitutions, deletions, insertions };
}

/**
 * Calculate Word Error Rate (WER) between hypothesis and reference.
 *
 * @param {string} hypothesis - ASR output text
 * @param {string} reference - Ground truth text
 * @returns {{
 *   wer: number,
 *   substitutions: number,
 *   deletions: number,
 *   insertions: number,
 *   refWords: number,
 *   hypWords: number,
 *   correct: number
 * }}
 */
export function wer(hypothesis, reference) {
  const hyp = tokenize(hypothesis);
  const ref = tokenize(reference);

  if (ref.length === 0) {
    return {
      wer: hyp.length > 0 ? 1.0 : 0.0,
      substitutions: 0,
      deletions: 0,
      insertions: hyp.length,
      refWords: 0,
      hypWords: hyp.length,
      correct: 0,
    };
  }

  const { distance, matrix } = levenshteinMatrix(hyp, ref);
  const errors = backtraceErrors(hyp, ref, matrix);

  const werValue = distance / ref.length;
  const correct = ref.length - errors.substitutions - errors.deletions;

  return {
    wer: werValue,
    ...errors,
    refWords: ref.length,
    hypWords: hyp.length,
    correct: Math.max(0, correct),
  };
}

/**
 * Calculate WER for multiple utterances (corpus-level).
 *
 * @param {Array<{hypothesis: string, reference: string}>} pairs
 * @returns {{
 *   wer: number,
 *   totalSubstitutions: number,
 *   totalDeletions: number,
 *   totalInsertions: number,
 *   totalRefWords: number,
 *   totalHypWords: number,
 *   utteranceCount: number,
 *   utterances: Array<{ wer: number, substitutions: number, deletions: number, insertions: number }>
 * }}
 */
export function corpusWer(pairs) {
  let totalSub = 0;
  let totalDel = 0;
  let totalIns = 0;
  let totalRef = 0;
  let totalHyp = 0;
  const utterances = [];

  for (const { hypothesis, reference } of pairs) {
    const result = wer(hypothesis, reference);
    totalSub += result.substitutions;
    totalDel += result.deletions;
    totalIns += result.insertions;
    totalRef += result.refWords;
    totalHyp += result.hypWords;
    utterances.push({
      wer: result.wer,
      substitutions: result.substitutions,
      deletions: result.deletions,
      insertions: result.insertions,
    });
  }

  const corpusWerValue = totalRef > 0
    ? (totalSub + totalDel + totalIns) / totalRef
    : 0;

  return {
    wer: corpusWerValue,
    totalSubstitutions: totalSub,
    totalDeletions: totalDel,
    totalInsertions: totalIns,
    totalRefWords: totalRef,
    totalHypWords: totalHyp,
    utteranceCount: pairs.length,
    utterances,
  };
}

/**
 * Format WER result as a human-readable string.
 *
 * @param {ReturnType<typeof wer>} result
 * @returns {string}
 */
export function formatWer(result) {
  const pct = (result.wer * 100).toFixed(2);
  return `WER: ${pct}% (S=${result.substitutions}, D=${result.deletions}, I=${result.insertions}, Ref=${result.refWords})`;
}
