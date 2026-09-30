// Hallucination scoring: multi-signal, never single-signal acoustic drop.
// Cases: silence, music, repeated hallucination, legitimate repeat, CJK,
// noisy speech, high noSpeechProb + good avgLogprob.
// Run: node backend/tests/sttHallucination.test.mjs

const { isHallucinatedText, filterHallucinatedSegments } = await import('../src/pipeline/sttUtils.js')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// Silence: blank → hallucinated
assert(isHallucinatedText('   ') === true, 'silence blank flagged')
assert(isHallucinatedText('', { noSpeechProb: 0.99, avgLogprob: -1.5, durationSec: 1 }) === true, 'empty with bad acoustics flagged')

// Music placeholder with bad acoustics → flagged
assert(isHallucinatedText('music music music music', { noSpeechProb: 0.92, avgLogprob: -1.2 }) === true, 'music loop with bad acoustics flagged')
assert(isHallucinatedText('Music music music', { noSpeechProb: 0.9, avgLogprob: -1.1 }) === true, 'music placeholder with bad acoustics flagged')

// Repeated hallucination: token loop + bad acoustics → flagged
assert(isHallucinatedText('ah ah ah ah ah ah ah', { noSpeechProb: 0.9, avgLogprob: -1.3 }) === true, 'repeated hallucination with bad acoustics flagged')
// Legacy compat: obvious loop without acoustic info still flagged (structural)
assert(isHallucinatedText('ah ah ah ah ah ah ah') === true, 'obvious token loop flagged even without acoustics')

// Legitimate repeated phrase with good confidence → kept
assert(isHallucinatedText('No no, I said no, listen to me please', { noSpeechProb: 0.2, avgLogprob: -0.3 }) === false, 'legitimate repeated phrase kept')
assert(isHallucinatedText('Happy birthday happy birthday to you', { noSpeechProb: 0.3, avgLogprob: -0.4 }) === false, 'legitimate song repeat kept')
assert(isHallucinatedText('ah ah ah ah ah', { noSpeechProb: 0.2, avgLogprob: -0.3 }) === false, 'moderate loop rescued by good logprob')

// CJK loop → flagged (strong structural)
assert(isHallucinatedText('谢谢谢谢谢谢谢谢谢谢谢谢谢谢') === true, 'CJK single-char loop flagged')

// Noisy speech: normal sentence, high noSpeechProb but good avgLogprob → kept
assert(isHallucinatedText('Hello world, how are you today?', { noSpeechProb: 0.9, avgLogprob: -0.3 }) === false, 'noisy speech with good logprob kept')
assert(isHallucinatedText('We need to move quickly now', { noSpeechProb: 0.88, avgLogprob: -0.4, durationSec: 2 }) === false, 'high noSpeech + good logprob kept')

// High noSpeechProb alone (normal text, no other signal) → kept (the fix)
assert(isHallucinatedText('music playing', { noSpeechProb: 0.9 }) === false, 'high noSpeechProb alone does not drop normal text')
assert(isHallucinatedText('real speech here', { noSpeechProb: 0.86 }) === false, 'high noSpeechProb alone kept')

// Low logprob alone → kept
assert(isHallucinatedText('Hello world today', { avgLogprob: -1.5 }) === false, 'low logprob alone kept')

// Silence triple-signal: very high noSpeech + low logprob + short duration → flagged
assert(isHallucinatedText('you you you', { noSpeechProb: 0.96, avgLogprob: -1.4, durationSec: 1.2 }) === true, 'silence triple-signal flagged')

// Filter integration
{
  const kept = filterHallucinatedSegments([
    { start: 0, end: 2, text: 'Hello world', noSpeechProb: 0.1, avgLogprob: -0.3 },
    { start: 2, end: 4, text: 'ah ah ah ah ah ah ah', noSpeechProb: 0.9, avgLogprob: -1.2 },
    { start: 4, end: 6, text: '   ' },
    { start: 6, end: 8, text: 'We need to move quickly.', noSpeechProb: 0.88, avgLogprob: -0.3 },
  ])
  assert(kept.length === 2, `filter keeps normal + noisy-speech, drops loop+blank (got ${kept.length})`)
  assert(kept.some((s) => s.text.includes('move quickly')), 'noisy speech with good logprob survives filter')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
