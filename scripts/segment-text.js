const nlp = require('compromise');

function segmentText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return [];
  }
  const doc = nlp(trimmed);
  const sentences = doc.sentences().out('array');
  if (!sentences.length) {
    return [trimmed];
  }
  return sentences.map((s) => s.trim()).filter(Boolean);
}

module.exports = { segmentText };
