import { useState, useEffect } from 'react';
import { settingsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Cpu, Check, Loader2 } from 'lucide-react';
import { LLM_PROVIDERS, IMAGE_PROVIDERS, VIDEO_PROVIDERS, VOICE_PROVIDERS, SUBTITLE_PROVIDERS } from '@/lib/constants';

const categories = [
  { key: 'active_llm_provider', label: 'LLM / Kịch bản', providers: LLM_PROVIDERS },
  { key: 'active_image_provider', label: 'Hình ảnh', providers: IMAGE_PROVIDERS },
  { key: 'active_video_provider', label: 'Video', providers: VIDEO_PROVIDERS },
  { key: 'active_voice_provider', label: 'Giọng nói', providers: VOICE_PROVIDERS },
  { key: 'active_subtitle_provider', label: 'Phụ đề', providers: SUBTITLE_PROVIDERS },
];

const providerLabels = {
  gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', huggingface: 'HuggingFace',
  flux: 'FLUX', stable_diffusion: 'Stable Diffusion', google_image: 'Google Image', huggingface_inference: 'HF Inference',
  kling: 'Kling', hailuo: 'Hailuo', pixverse: 'PixVerse', runway: 'Runway', luma: 'Luma',
  elevenlabs: 'ElevenLabs', google_tts: 'Google TTS', azure_speech: 'Azure Speech', openai_tts: 'OpenAI TTS',
  edge_tts: 'Edge TTS (Miễn phí)',
  whisper: 'Whisper (OpenAI/Groq)', openai_whisper: 'OpenAI Whisper', faster_whisper: 'Faster Whisper',
};

export default function ProviderSettings() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await settingsApi.get();
        setSettings(s);
      } catch (e) { console.error(e); }
    })();
  }, []);

  const selectProvider = async (key, provider) => {
    setSaving(true);
    try {
      const updated = await settingsApi.update({ [key]: provider });
      setSettings(updated);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  if (!settings) return <Layout><Loading /></Layout>;

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <PageHeader title="Cài Đặt Nhà Cung Cấp" subtitle="Chọn nhà cung cấp AI cho từng loại dịch vụ" />

        <div className="space-y-6">
          {categories.map((cat, ci) => (
            <motion.div
              key={cat.key}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: ci * 0.05 }}
              className="rounded-2xl bg-[#161922] border border-white/5 p-6"
            >
              <div className="flex items-center gap-2 mb-4">
                <Cpu className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-semibold text-white">{cat.label}</h3>
                {saving && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin ml-auto" />}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {cat.providers.map(p => {
                  const selected = settings[cat.key] === p;
                  return (
                    <button
                      key={p}
                      onClick={() => selectProvider(cat.key, p)}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm transition ${
                        selected ? 'border-blue-500 bg-blue-500/10 text-blue-300' : 'border-white/5 bg-white/[0.02] text-slate-300 hover:border-white/15'
                      }`}
                    >
                      <span>{providerLabels[p] || p}</span>
                      {selected && <Check className="w-3.5 h-3.5" />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </Layout>
  );
}