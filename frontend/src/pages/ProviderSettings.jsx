import { useState, useEffect } from 'react';
import { settingsApi, providersApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Cpu, Check, Loader2, KeyRound, Activity } from 'lucide-react';
import ErrorState from '@/components/ErrorState';
import { useToast } from '@/components/ui/use-toast';
import { LLM_PROVIDERS, IMAGE_PROVIDERS, VIDEO_PROVIDERS, VOICE_PROVIDERS, SUBTITLE_PROVIDERS } from '@/lib/constants';

const categories = [
  { key: 'active_llm_provider', group: 'llm', label: 'LLM / Kịch bản & Biên dịch', providers: LLM_PROVIDERS },
  { key: 'active_image_provider', group: 'vision', label: 'Hình ảnh & Thumbnail', providers: IMAGE_PROVIDERS },
  { key: 'active_video_provider', group: 'video', label: 'Kết xuất & Xử lý Video', providers: VIDEO_PROVIDERS },
  { key: 'active_voice_provider', group: 'tts', label: 'Tổng hợp giọng nói (TTS)', providers: VOICE_PROVIDERS },
  { key: 'active_subtitle_provider', group: 'asr', label: 'Phụ đề & Nhận diện lời (STT)', providers: SUBTITLE_PROVIDERS },
];

const providerLabels = {
  gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', huggingface: 'HuggingFace',
  flux: 'FLUX', stable_diffusion: 'Stable Diffusion', google_image: 'Google Image', huggingface_inference: 'HF Inference',
  kling: 'Kling', hailuo: 'Hailuo', pixverse: 'PixVerse', runway: 'Runway', luma: 'Luma',
  elevenlabs: 'ElevenLabs', google_tts: 'Google TTS', azure_speech: 'Azure Speech', openai_tts: 'OpenAI TTS',
  voicestudio: 'VoiceStudio (Local)', edge_tts: 'Edge TTS (Miễn phí)',
  whisper: 'Whisper (OpenAI/Groq)', openai_whisper: 'OpenAI Whisper', faster_whisper: 'Faster Whisper',
};

const KEYLESS_PROVIDERS = new Set(['voicestudio', 'edge_tts']);

export default function ProviderSettings() {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [providersData, setProvidersData] = useState(null);
  const [saving, setSaving] = useState(false);
  const [checkingVoiceStudio, setCheckingVoiceStudio] = useState(false);
  const { toast } = useToast();

  const checkVoiceStudioHealth = async (e) => {
    e?.stopPropagation?.();
    setCheckingVoiceStudio(true);
    try {
      const h = await providersApi.health('voicestudio');
      if (!h?.ok) throw new Error(h?.error || 'Dịch vụ VoiceStudio chưa phản hồi');
      toast({
        title: 'VoiceStudio sẵn sàng',
        description: 'Kết nối thành công tới VoiceStudio local service tại http://localhost:3900.',
      });
    } catch {
      toast({
        variant: 'destructive',
        title: 'Không thể kết nối VoiceStudio',
        description: 'VoiceStudio local service không phản hồi tại http://localhost:3900. Hãy kiểm tra dịch vụ VoiceStudio đang chạy và có thể truy cập được.',
      });
    } finally {
      setCheckingVoiceStudio(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const [s, p] = await Promise.all([
          settingsApi.get(),
          providersApi.list().catch(() => null),
        ]);
        setSettings(s);
        setProvidersData(p);
      } catch (e) {
        setLoadError(e);
      }
    })();
  }, []);

  const selectProvider = async (key, provider) => {
    setSaving(true);
    try {
      const updated = await settingsApi.update({ [key]: provider });
      setSettings(updated);
    } catch (e) {
      // U2: báo lỗi ra UI thay vì im lặng trong console.
      toast({
        variant: 'destructive',
        title: 'Không đổi được provider',
        description: e?.response?.data?.message || e.message,
      });
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <Layout><div className="p-6 lg:p-8 max-w-4xl mx-auto"><ErrorState status={loadError?.response?.status ?? 0} onRetry={() => window.location.reload()} /></div></Layout>;
  if (!settings) return <Layout><Loading /></Layout>;

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
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

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {cat.providers.map(p => {
                  const selected = settings[cat.key] === p;
                  const provList = providersData?.[cat.group];
                  const provInfo = Array.isArray(provList) ? provList.find(x => x.id === p) : null;
                  const isAvailable = provInfo ? provInfo.available !== false : true;
                  const hasKey = Boolean(provInfo?.hasKey);
                  const isKeyless = KEYLESS_PROVIDERS.has(p);
                  const successRate = provInfo?.health?.calls > 0 ? provInfo.health.successRate : null;

                  return (
                    <div
                      key={p}
                      role="button"
                      tabIndex={isAvailable ? 0 : -1}
                      aria-disabled={!isAvailable}
                      onClick={() => { if (isAvailable) selectProvider(cat.key, p); }}
                      onKeyDown={(e) => {
                        if (!isAvailable) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selectProvider(cat.key, p);
                        }
                      }}
                      className={`flex flex-col justify-between p-3 rounded-lg border text-left text-xs transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer ${
                        !isAvailable
                          ? 'opacity-40 border-border/40 bg-muted/20 cursor-not-allowed'
                          : selected
                          ? 'border-primary bg-primary/10 text-primary shadow-xs'
                          : 'border-border bg-muted/30 text-foreground hover:border-primary/40 hover:bg-muted/60'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between w-full mb-1">
                          <span className="font-semibold truncate">{providerLabels[p] || p}</span>
                          {selected && <Check className="w-4 h-4 shrink-0 text-primary ml-1" />}
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[10px]">
                          {!isAvailable ? (
                            <span className="text-muted-foreground italic">Chưa hỗ trợ</span>
                          ) : (
                            <>
                              {hasKey && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-medium">
                                  <KeyRound className="w-2.5 h-2.5" /> Có Key
                                </span>
                              )}
                              {isKeyless && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400 font-medium">
                                  {p === 'voicestudio' ? 'Local / Keyless' : 'Miễn phí'}
                                </span>
                              )}
                              {successRate !== null && (
                                <span className="text-muted-foreground font-mono">
                                  {successRate}% OK
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {p === 'voicestudio' && (
                        <div className="mt-2.5 pt-2 border-t border-border/40 flex flex-col gap-1.5 w-full">
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span className="text-[10px]">URL:</span>
                            <span className="font-mono text-[10px] text-foreground font-medium truncate">http://localhost:3900</span>
                          </div>
                          <button
                            type="button"
                            disabled={checkingVoiceStudio}
                            onClick={checkVoiceStudioHealth}
                            className="inline-flex items-center justify-center gap-1.5 px-2 py-1 rounded bg-secondary hover:bg-secondary/80 text-secondary-foreground text-[10px] font-medium transition-colors"
                            title="Kiểm tra kết nối dịch vụ VoiceStudio cục bộ"
                          >
                            {checkingVoiceStudio ? (
                              <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            ) : (
                              <Activity className="w-2.5 h-2.5 text-emerald-500" />
                            )}
                            <span>Kiểm tra kết nối (Health Check)</span>
                          </button>
                        </div>
                      )}
                    </div>
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