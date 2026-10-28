// dub.ttsAlign voice selection: project params.voiceProvider/voiceName must win
// over user settings, without breaking provider failover or cache identity.
// Run: node tests/dubTtsVoiceSelection.test.mjs
import { applyVoiceOverride } from '../src/pipeline/stages/dubTtsAlign.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

function candidates() {
  return [
    { id: 'zerotts', apiKeyId: null, provider: { id: 'zerotts', voice: 'maichi', model: 'zerotts' } },
    { id: 'edge_tts', apiKeyId: null, provider: { id: 'edge_tts', voice: 'vi-VN-HoaiMyNeural', model: 'edge_tts' } },
  ];
}

// 1. ZeroTTS + project voice → provider.voice, model untouched, failover pool untouched.
{
  const list = candidates();
  const out = applyVoiceOverride(list, 'zerotts', 'giahuy');
  assert(out[0].provider.voice === 'giahuy', 'zerotts: provider.voice = giahuy');
  assert(out[0].provider.model === 'zerotts', 'zerotts: model giữ nguyên (cache identity provider/model)');
  assert(out[1].provider.voice === 'vi-VN-HoaiMyNeural', 'edge_tts candidate unchanged');
}

// 2. Empty voice name → no override.
{
  const list = candidates();
  applyVoiceOverride(list, 'zerotts', '   ');
  assert(list[0].provider.voice === 'maichi', 'voiceName rỗng → unchanged');
  applyVoiceOverride(list, '', 'giahuy');
  assert(list[0].provider.voice === 'maichi', 'providerId rỗng → unchanged');
}

// 3. google_tts has no voice selection → unchanged.
{
  const list = [
    { id: 'google_tts', apiKeyId: null, provider: { id: 'google_tts', voice: 'default' } },
    { id: 'zerotts', apiKeyId: null, provider: { id: 'zerotts', voice: 'maichi' } },
  ];
  applyVoiceOverride(list, 'google_tts', 'some-voice');
  assert(list[0].provider.voice === 'default', 'google_tts không nhận voice override');
  assert(list[1].provider.voice === 'maichi', 'provider khác trong pool không bị đổi');
}

// 4. Unknown provider id → unchanged.
{
  const list = candidates();
  applyVoiceOverride(list, 'khong_ton_tai', 'giahuy');
  assert(list[0].provider.voice === 'maichi' && list[1].provider.voice === 'vi-VN-HoaiMyNeural',
    'provider không có trong pool → unchanged');
}

// 5. ElevenLabs uses voiceId.
{
  const list = [{ id: 'elevenlabs', apiKeyId: 'k1', provider: { id: 'elevenlabs', voiceId: '21m00Tcm4TlvDq8ikWAM' } }];
  applyVoiceOverride(list, 'elevenlabs', 'Rachel');
  assert(list[0].provider.voiceId === 'Rachel', 'elevenlabs: provider.voiceId = Rachel');
}

// 6. Trim + cap 64 chars.
{
  const list = candidates();
  const longName = `  ${'a'.repeat(80)}  `;
  applyVoiceOverride(list, 'zerotts', longName);
  assert(list[0].provider.voice === 'a'.repeat(64), 'voice name được trim + cap 64 ký tự');
}

if (failures > 0) {
  console.error(`\n${failures} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
