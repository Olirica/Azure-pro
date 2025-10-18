/**
 * Backward Peek Gender Correction Test
 *
 * Tests the peek-detector and backward peek translation revision functionality.
 * This is a unit test for the peek detection logic and integration.
 */

const { detectGender, hasAmbiguousPronouns, shouldPerformBackwardPeek } = require('../server/peek-detector');

console.log('=== Backward Peek Gender Correction Tests ===\n');

// Test 1: Gender detection - Female markers
console.log('Test 1: Detect female gender markers');
const femaleTest1 = detectGender('Mrs. Smith said she was happy', 'en');
console.log('  Input: "Mrs. Smith said she was happy"');
console.log('  Result:', femaleTest1);
console.log('  ✓ Expected: gender=female, confidence>0.5\n');

// Test 2: Gender detection - Male markers
console.log('Test 2: Detect male gender markers');
const maleTest1 = detectGender('Mr. Johnson said he was ready', 'en');
console.log('  Input: "Mr. Johnson said he was ready"');
console.log('  Result:', maleTest1);
console.log('  ✓ Expected: gender=male, confidence>0.5\n');

// Test 3: No gender markers
console.log('Test 3: No gender markers detected');
const neutralTest = detectGender('The person went to the store', 'en');
console.log('  Input: "The person went to the store"');
console.log('  Result:', neutralTest);
console.log('  ✓ Expected: gender=null, confidence=0\n');

// Test 4: Ambiguous pronouns detection - English
console.log('Test 4: Detect ambiguous pronouns (English)');
const ambiguousEN = hasAmbiguousPronouns('They said they would come later', 'en');
console.log('  Input: "They said they would come later"');
console.log('  Result:', ambiguousEN);
console.log('  ✓ Expected: true\n');

// Test 5: Ambiguous pronouns detection - French
console.log('Test 5: Detect ambiguous pronouns (French)');
const ambiguousFR = hasAmbiguousPronouns('Ils ont dit leur opinion', 'fr');
console.log('  Input: "Ils ont dit leur opinion"');
console.log('  Result:', ambiguousFR);
console.log('  ✓ Expected: true\n');

// Test 6: Backward peek decision - Should peek (ambiguous → gender revealed)
console.log('Test 6: Backward peek decision - SHOULD peek');
const previousSegment = {
  text: 'The doctor said they were ready',
  srcLang: 'en',
  unitId: 'test|en|1'
};
const newSegment = {
  text: 'Mrs. Smith confirmed the diagnosis',
  srcLang: 'en',
  unitId: 'test|en|2'
};
const peekDecision1 = shouldPerformBackwardPeek(newSegment, previousSegment);
console.log('  Previous: "The doctor said they were ready" (ambiguous)');
console.log('  New: "Mrs. Smith confirmed the diagnosis" (female marker)');
console.log('  Result:', peekDecision1);
console.log('  ✓ Expected: shouldPeek=true, gender=female, confidence≥0.7\n');

// Test 7: Backward peek decision - Should NOT peek (no ambiguous pronouns)
console.log('Test 7: Backward peek decision - should NOT peek (no ambiguous)');
const previousSegment2 = {
  text: 'The doctor confirmed the results',
  srcLang: 'en',
  unitId: 'test|en|3'
};
const newSegment2 = {
  text: 'Mrs. Smith was satisfied',
  srcLang: 'en',
  unitId: 'test|en|4'
};
const peekDecision2 = shouldPerformBackwardPeek(newSegment2, previousSegment2);
console.log('  Previous: "The doctor confirmed the results" (no pronouns)');
console.log('  New: "Mrs. Smith was satisfied" (female marker)');
console.log('  Result:', peekDecision2);
console.log('  ✓ Expected: shouldPeek=false, reason="no_ambiguous_pronouns"\n');

// Test 8: Backward peek decision - Should NOT peek (no gender marker)
console.log('Test 8: Backward peek decision - should NOT peek (no gender)');
const previousSegment3 = {
  text: 'They said they would help',
  srcLang: 'en',
  unitId: 'test|en|5'
};
const newSegment3 = {
  text: 'The person arrived on time',
  srcLang: 'en',
  unitId: 'test|en|6'
};
const peekDecision3 = shouldPerformBackwardPeek(newSegment3, previousSegment3);
console.log('  Previous: "They said they would help" (ambiguous)');
console.log('  New: "The person arrived on time" (no gender)');
console.log('  Result:', peekDecision3);
console.log('  ✓ Expected: shouldPeek=false, reason="no_strong_gender_marker"\n');

// Test 9: French gender markers
console.log('Test 9: French gender markers');
const frenchFemale = detectGender('Madame Dupont a dit', 'fr');
const frenchMale = detectGender('Monsieur Martin est arrivé', 'fr');
console.log('  French female: "Madame Dupont a dit"');
console.log('  Result:', frenchFemale);
console.log('  French male: "Monsieur Martin est arrivé"');
console.log('  Result:', frenchMale);
console.log('  ✓ Expected: Both should detect correct gender\n');

// Test 10: Language mismatch
console.log('Test 10: Language mismatch - should NOT peek');
const previousSegment4 = {
  text: 'They were happy',
  srcLang: 'en',
  unitId: 'test|en|7'
};
const newSegment4 = {
  text: 'Madame Dupont a confirmé',
  srcLang: 'fr',
  unitId: 'test|fr|1'
};
const peekDecision4 = shouldPerformBackwardPeek(newSegment4, previousSegment4);
console.log('  Previous: English "They were happy"');
console.log('  New: French "Madame Dupont a confirmé"');
console.log('  Result:', peekDecision4);
console.log('  ✓ Expected: shouldPeek=false, reason="language_mismatch"\n');

console.log('=== Test Summary ===');
console.log('All 10 test scenarios completed.');
console.log('Review results above to verify expected behavior.');
console.log('\nTo test the full pipeline integration:');
console.log('1. Start the server: npm start');
console.log('2. Open speaker.html and listener.html');
console.log('3. Say: "The doctor said they were ready"');
console.log('4. Say: "Mrs. Smith confirmed the diagnosis"');
console.log('5. Check listener sees revised translation with correct gender\n');
