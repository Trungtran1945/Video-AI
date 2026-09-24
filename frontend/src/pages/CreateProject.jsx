import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronRight, ChevronLeft, Globe, Clock, Palette, Mic, Wand2, Loader2, Upload, Film, Clapperboard, Languages, AlertCircle, AudioLines, AlertTriangle, ScanText } from 'lucide-react';
import {
  LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS,
  MODE_LABELS, SOURCE_LANGUAGES, TARGET_LANGUAGES,
  STYLE_PRESETS_FALLBACK,
} from '@/lib/constants';
import { projectsApi } from '@/api/projects';
import { uploadApi } from '@/api/upload';
import { VIDEO_ACCEPT } from '@/lib/videoFiles';
import Layout from '@/components/Layout';

function FreeTierWarning({ mode, estimatedDuration }) {
  const thresholds = { SUMMARY: 60 * 60, TRANSLATE_DUB: 20 * 60 };
  const threshold = thresholds[mode];
  if (!threshold || !estimatedDuration || estimatedDuration <= threshold) return null;

  return (
    <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4 text-left">
      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm text-amber-800 dark:text-amber-300 font-semibold">Cảnh báo hạn mức miễn phí (Free Tier)</p>
        <p className="text-xs text-amber-700/80 dark:text-amber-300/70 mt-1 leading-relaxed">
          Với API key miễn phí, xử lý nội dung dài có thể chậm hơn nhiều do giới hạn tốc độ của nhà cung cấp.
          Khuyến nghị thử nghiệm với clip ngắn (≤ 10 phút) trước.
        </p>
      </div>
    </div>
  );
}

const SUMMARY_DURATIONS = [
  { value: 1200, label: '20 phút', desc: 'Ngắn gọn, súc tích' },
  { value: 1500, label: '25 phút', desc: 'Tiêu chuẩn thịnh hành' },
  { value: 1800, label: '30 phút', desc: 'Chi tiết, phân tích sâu' },
];

export default function CreateProject() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState(STYLE_PRESETS_FALLBACK);
  const [copyrightAck, setCopyrightAck] = useState(false);
  const [form, setForm] = useState({
    mode: null,
    title: '',
    sourceVideoKey: null,
    sourceFileName: '',
    videoHash: null,
    language: 'vi',
    targetDurationSec: 1500,
    style: 'cinematic',
    tone: '',
    spoilerAllowed: false,
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    stylePreset: null,
    enableDubbing: false,
    voiceProvider: 'elevenlabs',
    voiceName: '',
    subPosition: 'original',
    ocrMode: false,
  });

  const update = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const summarySteps = [
    { key: 'movie', label: 'Phim', icon: Film },
    { key: 'language', label: 'Ngôn ngữ', icon: Globe },
    { key: 'duration', label: 'Độ dài', icon: Clock },
    { key: 'style', label: 'Phong cách', icon: Palette },
    { key: 'voice', label: 'Giọng đọc', icon: Mic },
    { key: 'generate', label: 'Tạo video', icon: Wand2 },
  ];
  const dubSteps = [
    { key: 'video', label: 'Video', icon: Film },
    { key: 'language', label: 'Ngôn ngữ', icon: Globe },
    { key: 'preset', label: 'Biên dịch', icon: Languages },
    { key: 'dubbing', label: 'Lồng tiếng AI', icon: Mic },
    { key: 'generate', label: 'Tạo video', icon: Wand2 },
  ];
  const steps = form.mode === 'SUMMARY' ? summarySteps : dubSteps;

  useEffect(() => {
    if (form.mode !== 'TRANSLATE_DUB') return;
    let alive = true;
    projectsApi.stylePresets().then((data) => {
      if (!alive || !data) return;
      const list = Array.isArray(data) ? data : data?.items || data?.data;
      if (Array.isArray(list) && list.length) {
        setPresets(list.map((p) => ({ slug: p.slug, name: p.name, description: p.description })));
      }
    });
    return () => { alive = false; };
  }, [form.mode]);

  const handleMovie = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);
    setUploadPercent(0);
    try {
      const res = await uploadApi.upload(file, { onProgress: setUploadPercent });
      update('sourceVideoKey', res.key);
      update('sourceFileName', file.name);
      update('videoHash', res.videoHash || null);
    } catch (err) {
      setError('Tải phim thất bại: ' + (err?.response?.data?.message || err.message));
    } finally {
      setUploading(false);
      setUploadPercent(0);
    }
  };

  const canNext = () => {
    if (form.mode === 'SUMMARY') {
      if (step === 0) return !!form.sourceVideoKey;
      if (step === 1) return !!form.language;
      if (step === 2) return !!form.targetDurationSec;
      if (step === 3) return !!form.style;
      if (step === 4) return !!form.voiceProvider;
      return true;
    }
    if (step === 0) return !!form.sourceVideoKey && !uploading;
    if (step === 1) {
      if (!form.targetLanguage) return false;
      if (form.ocrMode && form.sourceLanguage === 'auto') return false;
      return true;
    }
    if (step === 2) return !!form.stylePreset;
    if (step === 3) return !form.enableDubbing || !!form.voiceProvider;
    return true;
  };

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      let payload;
      if (form.mode === 'SUMMARY') {
        payload = {
          mode: 'SUMMARY',
          title: form.title.trim() || 'Review phim mới',
          language: form.language,
          style: form.style,
          targetDurationSec: form.targetDurationSec,
          sourceVideoKey: form.sourceVideoKey,
          videoHash: form.videoHash,
          copyrightAcknowledged: copyrightAck,
          params: { tone: form.tone, spoilerAllowed: form.spoilerAllowed, voiceProvider: form.voiceProvider, voiceName: form.voiceName },
        };
      } else {
        payload = {
          mode: 'TRANSLATE_DUB',
          title: form.title.trim() || 'Video Việt hoá mới',
          sourceLanguage: form.sourceLanguage,
          targetLanguage: form.targetLanguage,
          stylePreset: form.stylePreset,
          enableDubbing: form.enableDubbing,
          subPosition: form.subPosition,
          sourceVideoKey: form.sourceVideoKey,
          videoHash: form.videoHash,
          ocrMode: form.ocrMode,
          copyrightAcknowledged: copyrightAck,
          params: form.enableDubbing
            ? { voiceProvider: form.voiceProvider, voiceName: form.voiceName, subPosition: form.subPosition }
            : { subPosition: form.subPosition },
        };
      }
      const project = await projectsApi.create(payload);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError('Không thể tạo dự án: ' + (err?.response?.data?.message || err.message));
      setCreating(false);
    }
  };

  if (!form.mode) {
    return (
      <Layout>
        <div className="max-w-3xl mx-auto p-6 lg:p-8">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Tạo Dự Án Mới</h1>
            <p className="text-sm text-muted-foreground mt-1.5">Chọn chế độ sản xuất video tự động bằng trí tuệ nhân tạo</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <ModeCard
              onClick={() => update('mode', 'SUMMARY')}
              icon={Clapperboard}
              title="Review Phim Tự Động"
              desc="Tải phim 2–3 tiếng, AI cắt cảnh và viết lời review thành video 20–30 phút. Giọng đọc khớp nhịp cảnh hoàn hảo."
            />
            <ModeCard
              onClick={() => update('mode', 'TRANSLATE_DUB')}
              icon={Languages}
              title="Dịch Thuật & Lồng Tiếng"
              desc="Tải video nước ngoài có phụ đề cứng, dịch tiếng Việt theo 13 phong cách, tuỳ chọn lồng giọng AI. Tự khoanh vùng che chữ trên editor."
            />
          </div>
        </div>
      </Layout>
    );
  }

  const isDub = form.mode === 'TRANSLATE_DUB';
  const selectedPreset = presets.find((p) => p.slug === form.stylePreset);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-2xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">
            {MODE_LABELS[form.mode] || form.mode}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Hoàn thành {steps.length} bước để AI bắt đầu quy trình sản xuất</p>
        </div>

        <StepIndicator steps={steps} step={step} />

        <div className="rounded-2xl bg-card border border-border p-6 min-h-[320px] shadow-sm">
          <AnimatePresence mode="wait">
            <motion.div
              key={form.mode + step}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.18 }}
            >
              {form.mode === 'SUMMARY' && step === 0 && (
                <UploadBlock
                  label="Tải phim cần review (2–3 tiếng)"
                  fileName={form.sourceFileName}
                  onChange={handleMovie}
                  accept={VIDEO_ACCEPT}
                  uploading={uploading}
                  hint="Định dạng MP4, MOV, M4V, MKV, WebM"
                />
              )}

              {isDub && step === 0 && (
                <div className="space-y-4">
                  <UploadBlock
                    label="Tải video cần Việt hoá (tối đa 2GB)"
                    fileName={form.sourceFileName}
                    onChange={handleMovie}
                    accept={VIDEO_ACCEPT}
                    uploading={uploading}
                    hint="MP4, MOV, M4V, MKV, WebM · tự khôi phục khi mất mạng"
                  />
                  {uploading && (
                    <div className="space-y-1.5">
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all"
                          style={{ width: `${uploadPercent}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground text-right">{uploadPercent}%</p>
                    </div>
                  )}
                </div>
              )}

              {form.mode === 'SUMMARY' && step === 1 && (
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
                    <OptionCard key={code} selected={form.language === code} onClick={() => update('language', code)} title={label} />
                  ))}
                </div>
              )}

              {isDub && step === 1 && (
                <div className="space-y-5">
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">Ngôn ngữ nguồn</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(SOURCE_LANGUAGES).map(([code, label]) => (
                        <OptionCard key={code} selected={form.sourceLanguage === code} onClick={() => update('sourceLanguage', code)} title={label} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">Dịch sang</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(TARGET_LANGUAGES).map(([code, label]) => (
                        <OptionCard key={code} selected={form.targetLanguage === code} onClick={() => update('targetLanguage', code)} title={label} />
                      ))}
                    </div>
                  </div>
                  {isDub && step === 1 && form.sourceLanguage !== 'auto' && (
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => update('ocrMode', !form.ocrMode)}
                        className={`w-full flex items-center justify-between p-4 rounded-xl border transition-all ${
                          form.ocrMode
                            ? 'border-primary bg-primary/10'
                            : 'border-border bg-card hover:bg-muted/40'
                        }`}
                      >
                        <div className="text-left">
                          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                            <ScanText className="w-4 h-4 text-primary" />
                            <span>OCR phụ đề cứng trong video</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {form.ocrMode ? 'Bật — nhận dạng chữ từ phụ đề trong video' : 'Tắt — dùng nhận dạng giọng nói (ASR)'}
                          </div>
                        </div>
                        <span className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${form.ocrMode ? 'bg-primary' : 'bg-muted'}`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${form.ocrMode ? 'translate-x-5' : ''}`} />
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {form.mode === 'SUMMARY' && step === 2 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {SUMMARY_DURATIONS.map((d) => (
                    <OptionCard key={d.value} selected={form.targetDurationSec === d.value} onClick={() => update('targetDurationSec', d.value)} title={d.label} desc={d.desc} />
                  ))}
                </div>
              )}

              {form.mode === 'SUMMARY' && step === 3 && (
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">Phong cách review</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(STYLE_LABELS).map(([code, label]) => (
                        <OptionCard key={code} selected={form.style === code} onClick={() => update('style', code)} title={label} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">Giọng điệu (tone)</label>
                    <input
                      value={form.tone}
                      onChange={(e) => update('tone', e.target.value)}
                      placeholder="VD: hài hước, gay cấn, sâu sắc..."
                      className="w-full px-4 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={form.spoilerAllowed}
                      onChange={(e) => update('spoilerAllowed', e.target.checked)}
                      className="w-4 h-4 accent-primary rounded"
                    />
                    <span className="text-sm text-foreground">Cho phép tiết lộ toàn bộ chi tiết (spoiler kết phim)</span>
                  </label>
                </div>
              )}

              {form.mode === 'SUMMARY' && step === 4 && (
                <VoiceStep form={form} update={update} />
              )}

              {isDub && step === 2 && (
                <div>
                  <label className="text-sm font-semibold text-foreground mb-2 block">Phong cách dịch (13 phong cách chuyên nghiệp)</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[360px] overflow-y-auto pr-1">
                    {presets.map((p) => (
                      <OptionCard
                        key={p.slug}
                        selected={form.stylePreset === p.slug}
                        onClick={() => update('stylePreset', p.slug)}
                        title={p.name}
                        desc={p.description}
                      />
                    ))}
                  </div>
                </div>
              )}

              {isDub && step === 3 && (
                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={() => update('enableDubbing', !form.enableDubbing)}
                    className={`w-full flex items-center justify-between p-4 rounded-xl border transition-all ${
                      form.enableDubbing
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-card hover:bg-muted/40'
                    }`}
                  >
                    <div className="text-left">
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <AudioLines className="w-4 h-4 text-primary" />
                        <span>Lồng tiếng AI ép khớp thời gian</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {form.enableDubbing ? 'Bật — giọng đọc AI thay thế audio gốc, ép khớp thời gian thoại' : 'Tắt — giữ nguyên âm thanh gốc, chỉ thay phụ đề'}
                      </div>
                    </div>
                    <span className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${form.enableDubbing ? 'bg-primary' : 'bg-muted'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${form.enableDubbing ? 'translate-x-5' : ''}`} />
                    </span>
                  </button>
                  {form.enableDubbing && <VoiceStep form={form} update={update} />}
                </div>
              )}

              {((form.mode === 'SUMMARY' && step === 5) || (isDub && step === 4)) && (
                <div>
                  <div className="text-center mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-blue-500/25">
                      <Wand2 className="w-7 h-7 text-white" />
                    </div>
                    <h3 className="text-lg font-bold text-foreground">Sẵn sàng khởi tạo!</h3>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1">Kiểm tra lại thông số trước khi đưa dự án vào hàng đợi xử lý.</p>
                  </div>

                  <div className="mb-4">
                    <label className="flex items-start gap-3 p-3.5 rounded-xl bg-muted/50 border border-border cursor-pointer hover:border-primary/40 transition-colors">
                      <input
                        type="checkbox"
                        checked={copyrightAck}
                        onChange={(e) => setCopyrightAck(e.target.checked)}
                        className="mt-0.5 w-4 h-4 rounded border-input text-primary focus:ring-primary accent-primary"
                      />
                      <span className="text-xs sm:text-sm text-foreground leading-relaxed">
                        Tôi xác nhận quyền sở hữu hoặc quyền sử dụng hợp pháp đối với video nguồn và chịu trách nhiệm pháp lý với nội dung thành phẩm.
                      </span>
                    </label>
                  </div>

                  <FreeTierWarning mode={form.mode} estimatedDuration={isDub ? form.targetDurationSec : form.targetDurationSec} />

                  <div className="space-y-3">
                    <input
                      value={form.title}
                      onChange={(e) => update('title', e.target.value)}
                      placeholder="Tên dự án (tùy chọn)"
                      className="w-full px-4 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <div className="rounded-xl bg-muted/40 border border-border p-4 space-y-2.5 text-xs sm:text-sm">
                      {(isDub
                        ? [
                            ['Chế độ', MODE_LABELS.TRANSLATE_DUB],
                            ['Video nguồn', form.sourceFileName],
                            ['Ngôn ngữ', `${SOURCE_LANGUAGES[form.sourceLanguage]} → ${TARGET_LANGUAGES[form.targetLanguage]}`],
                            ['Phong cách dịch', selectedPreset ? `${selectedPreset.name}` : form.stylePreset],
                            ['Lồng tiếng AI', form.enableDubbing ? `Bật (${VOICE_PROVIDER_LABELS[form.voiceProvider] || form.voiceProvider})` : 'Tắt'],
                            ['OCR phụ đề cứng', form.ocrMode ? 'Bật' : 'Tắt'],
                          ]
                        : [
                            ['Chế độ', MODE_LABELS.SUMMARY],
                            ['Ngôn ngữ', LANGUAGE_LABELS[form.language] || form.language],
                            ['Độ dài mục tiêu', form.targetDurationSec >= 60 ? `${Math.round(form.targetDurationSec / 60)} phút` : `${form.targetDurationSec} giây`],
                            ['Phong cách review', STYLE_LABELS[form.style] || form.style],
                            ['Giọng đọc AI', VOICE_PROVIDER_LABELS[form.voiceProvider] || form.voiceProvider],
                          ]
                      ).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="text-foreground font-semibold text-right max-w-[60%] truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center justify-between mt-6">
          <button
            onClick={() => (step > 0 ? setStep(step - 1) : update('mode', null))}
            disabled={creating || uploading}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>{step === 0 ? 'Chọn lại chế độ' : 'Quay lại'}</span>
          </button>
          {step < steps.length - 1 ? (
            <button
              onClick={() => canNext() && setStep(step + 1)}
              disabled={!canNext() || uploading}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition-all disabled:opacity-40 shadow-sm shadow-primary/20"
            >
              <span>Tiếp tục</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating || uploading || !copyrightAck}
              className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-semibold transition-all shadow-md shadow-primary/25 disabled:opacity-50"
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Đang khởi tạo...</span>
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  <span>Bắt đầu tạo</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </Layout>
  );
}

// ── Shared Subcomponents ──
function StepIndicator({ steps, step }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-8 overflow-x-auto pb-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1 shrink-0">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
              i === step
                ? 'bg-primary text-primary-foreground shadow-xs'
                : i < step
                ? 'bg-primary/15 text-primary'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < step ? <Check className="w-3.5 h-3.5" /> : <s.icon className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{s.label}</span>
          </div>
          {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground/40" />}
        </div>
      ))}
    </div>
  );
}

function OptionCard({ selected, onClick, title, desc, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-4 rounded-xl border transition-all w-full ${
        selected
          ? 'border-primary bg-primary/10 shadow-xs'
          : 'border-border bg-card hover:bg-muted/40 hover:border-primary/30'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {desc && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</div>}
        </div>
        {selected && <Check className="w-4 h-4 text-primary shrink-0 ml-2" />}
      </div>
      {children}
    </button>
  );
}

function ModeCard({ onClick, icon: Icon, title, desc }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left p-6 rounded-2xl border border-border bg-card hover:border-primary/40 hover:bg-primary/5 transition-all group shadow-sm hover:shadow-md"
    >
      <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
        <Icon className="w-6 h-6" />
      </div>
      <div className="text-lg font-bold text-foreground group-hover:text-primary transition-colors">{title}</div>
      <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{desc}</p>
    </button>
  );
}

function UploadBlock({ label, fileName, onChange, accept, multiple, uploading, hint }) {
  return (
    <div>
      <label className="text-sm font-semibold text-foreground mb-2 block">{label}</label>
      <label
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-2xl py-10 transition-all ${
          uploading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
        } ${
          fileName
            ? 'border-primary/50 bg-primary/5'
            : 'border-border hover:border-primary/40 bg-muted/20'
        }`}
      >
        <Upload className="w-8 h-8 text-primary/70" />
        <span className="text-sm font-semibold text-foreground">{fileName || 'Nhấn hoặc kéo thả tệp video vào đây'}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        {uploading && <Loader2 className="w-5 h-5 animate-spin text-primary mt-2" />}
        <input type="file" accept={accept} multiple={multiple} onChange={onChange} className="hidden" />
      </label>
    </div>
  );
}

function VoiceStep({ form, update, optional }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-semibold text-foreground mb-2 block">
          {optional ? 'Giọng đọc (tuỳ chọn)' : 'Nhà cung cấp giọng đọc AI'}
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(VOICE_PROVIDER_LABELS).map(([code, label]) => (
            <OptionCard
              key={code}
              selected={form.voiceProvider === code}
              onClick={() => update('voiceProvider', code)}
              title={label}
            />
          ))}
        </div>
      </div>
      <div>
        <label className="text-sm font-semibold text-foreground mb-2 block">Tên giọng / Voice ID (tuỳ chọn)</label>
        <input
          value={form.voiceName}
          onChange={(e) => update('voiceName', e.target.value)}
          placeholder="VD: Rachel, Adam, Josh..."
          className="w-full px-4 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
    </div>
  );
}
