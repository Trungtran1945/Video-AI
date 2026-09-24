import { useState, useEffect } from 'react';
import { settingsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Cpu, Check, Loader2 } from 'lucide-react';
import { LLM_PROVIDERS, IMAGE_PROVIDERS, VIDEO_PROVIDERS, VOICE_PROVIDERS, SUBTITLE_PROVIDERS } from '@/lib/constants';

const categories = [
  { key: 'active_llm_provider', label: 'LLM / Kịch bản & Biên dịch', providers: LLM_PROVIDERS },
  { key: 'active_image_provider', label: 'Hình ảnh & Thumbnail', providers: IMAGE_PROVIDERS },
  { key: 'active_video_provider', label: 'Kết xuất & Xử lý Video', providers: VIDEO_PROVIDERS },
  { key: 'active_voice_provider', label: 'Tổng hợp giọng nói (TTS)', providers: VOICE_PROVIDERS },
  { key: 'active_subtitle_provider', label: 'Phụ đề & Nhận diện lời (STT)', providers: SUBTITLE_PROVIDERS },
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
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  const selectProvider = async (key, provider) => {
    setSaving(true);
    try {
      const updated = await settingsApi.update({ [key]: provider });
      setSettings(updated);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <Layout><Loading /></Layout>;

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
        <PageHeader
          title="Nhà Cung Cấp AI"
          subtitle="Chỉ định nhà cung cấp dịch vụ AI hoạt động cho từng phân hệ xử lý"
        />

        <div className="space-y-5">
          {categories.map((cat, ci) => (
            <motion.div
              key={cat.key}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: ci * 0.04 }}
              className="rounded-xl bg-card border border-border p-6 shadow-xs"
            >
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Cpu className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">{cat.label}</h3>
                {saving && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin ml-auto" />}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {cat.providers.map(p => {
                  const selected = settings[cat.key] === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => selectProvider(cat.key, p)}
                      className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg border text-xs sm:text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                        selected
                          ? 'border-primary bg-primary/10 text-primary shadow-xs font-semibold'
                          : 'border-border bg-muted/30 text-foreground hover:border-primary/40 hover:bg-muted/60'
                      }`}
                    >
                      <span className="truncate">{providerLabels[p] || p}</span>
                      {selected && <Check className="w-4 h-4 shrink-0 text-primary ml-1.5" />}
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