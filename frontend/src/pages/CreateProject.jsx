import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronRight, ChevronLeft, Globe, Clock, Palette, Mic, Wand2, Loader2, Upload, Film, Clapperboard, Languages, AlertCircle, AudioLines, Eraser } from 'lucide-react';
import {
  LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS,
  MODE_LABELS, MASK_METHODS, SOURCE_LANGUAGES, TARGET_LANGUAGES,
  STYLE_PRESETS_FALLBACK,
} from '@/lib/constants';
import { projectsApi } from '@/api/projects';
import { uploadApi } from '@/api/upload';
import Layout from '@/components/Layout';

const SUMMARY_DURATIONS = [
  { value: 1200, label: '20 phút', desc: 'Ngắn gọn' },
  { value: 1500, label: '25 phút', desc: 'Tiêu chuẩn' },
  { value: 1800, label: '30 phút', desc: 'Chi tiết' },
];

export default function CreateProject() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState(STYLE_PRESETS_FALLBACK);
  const [form, setForm] = useState({
    mode: null, // 'SUMMARY' | 'TRANSLATE_DUB'
    title: '',
    sourceVideoKey: null,
    sourceFileName: '',
    language: 'vi',
    targetDurationSec: 1500,
    style: 'cinematic',
    tone: '',
    spoilerAllowed: false,
    // TRANSLATE_DUB
    sourceLanguage: 'auto',
    targetLanguage: 'vi',
    stylePreset: null,
    enableDubbing: false,
    voiceProvider: 'elevenlabs',
    voiceName: '',
    maskMethod: 'fill',
    maskStrength: 0.6,
    subPosition: 'original',
  });

  const update = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const summarySteps = [
    { key: 'movie', label: 'Phim', icon: Film },
    { key: 'language', label: 'Ngôn ngữ', icon: Globe },
    { key: 'duration', label: 'Độ dài', icon: Clock },
    { key: 'style', label: 'Phong cách', icon: Palette },
    { key: 'voice', label: 'Giọng đọc', icon: Mic },
    { key: 'generate', label: 'Tạo', icon: Wand2 },
  ];
  const dubSteps = [
    { key: 'video', label: 'Video', icon: Film },
    { key: 'language', label: 'Ngôn ngữ', icon: Globe },
    { key: 'preset', label: 'Phong cách dịch', icon: Languages },
    { key: 'dubbing', label: 'Lồng tiếng AI', icon: Mic },
    { key: 'advanced', label: 'Nâng cao', icon: Eraser },
    { key: 'generate', label: 'Tạo', icon: Wand2 },
  ];
  const steps = form.mode === 'SUMMARY' ? summarySteps : dubSteps;

  // Lấy danh sách 12 preset từ backend; lỗi/404 → fallback hardcode
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

  // ── Upload handlers ──
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
    } catch (err) {
      setError('Tải phim thất bại: ' + (err?.response?.data?.message || err.message));
    } finally {
      setUploading(false);
      setUploadPercent(0);
    }
  };

  // ── Validation ──
  const canNext = () => {
    if (form.mode === 'SUMMARY') {
      if (step === 0) return !!form.sourceVideoKey;
      if (step === 1) return !!form.language;
      if (step === 2) return !!form.targetDurationSec;
      if (step === 3) return !!form.style;
      if (step === 4) return !!form.voiceProvider;
      return true;
    }
    // TRANSLATE_DUB
    if (step === 0) return !!form.sourceVideoKey && !uploading;
    if (step === 1) return !!form.targetLanguage;
    if (step === 2) return !!form.stylePreset;
    if (step === 3) return !form.enableDubbing || !!form.voiceProvider;
    if (step === 4) return !!form.maskMethod;
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
          maskMethod: form.maskMethod,
          maskStrength: Number(form.maskStrength) || 0.6,
          subPosition: form.subPosition,
          sourceVideoKey: form.sourceVideoKey,
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

  // ── Mode selection screen ──
  if (!form.mode) {
    return (
      <Layout>
        <div className="max-w-3xl mx-auto p-6 lg:p-8">
          <h1 className="text-2xl font-bold text-white mb-1">Tạo Dự Án Mới</h1>
          <p className="text-sm text-slate-400 mb-8">Chọn chế độ sản xuất video tự động</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ModeCard
              onClick={() => update('mode', 'SUMMARY')}
              icon={Clapperboard}
              title="Review Phim"
              desc="Tải phim 2–3 tiếng, AI cắt cảnh và viết lời review thành video 20–30 phút. Giọng đọc khớp với cảnh."
            />
            <ModeCard
              onClick={() => update('mode', 'TRANSLATE_DUB')}
              icon={Languages}
              title="Dịch Thuật & Lồng Tiếng"
              desc="Tải video nước ngoài có phụ đề cứng, AI quét OCR + dịch tiếng Việt theo 12 phong cách, tuỳ chọn lồng giọng AI — giữ nguyên hình ảnh gốc."
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
          <h1 className="text-2xl font-bold text-white">
            {MODE_LABELS[form.mode] || form.mode}
          </h1>
          <p className="text-sm text-slate-400 mt-1">Hoàn thành {steps.length} bước để AI bắt đầu tạo video</p>
        </div>

        <StepIndicator steps={steps} step={step} />

        <div className="rounded-2xl bg-[#161922] border border-white/5 p-6 min-h-[300px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={form.mode + step}
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {/* SUMMARY: movie */}
              {form.mode === 'SUMMARY' && step === 0 && (
                <UploadBlock label="Tải phim cần review (2–3 tiếng)" fileName={form.sourceFileName}
                  onChange={handleMovie} accept="video/*" uploading={uploading} hint="Định dạng MP4, MOV, MKV..." />
              )}

              {/* TRANSLATE_DUB: video nguồn (≤2GB, resumable) */}
              {isDub && step === 0 && (
                <div className="space-y-3">
                  <UploadBlock label="Tải video cần Việt hoá (tối đa 2GB)" fileName={form.sourceFileName}
                    onChange={handleMovie} accept="video/*" uploading={uploading}
                    hint="Upload chia chunk tự động phục hồi khi mất mạng" />
                  {uploading && (
                    <div className="space-y-1.5">
                      <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all" style={{ width: `${uploadPercent}%` }} />
                      </div>
                      <p className="text-xs text-slate-400 text-right">{uploadPercent}%</p>
                    </div>
                  )}
                </div>
              )}

              {/* Language (SUMMARY) */}
              {form.mode === 'SUMMARY' && step === 1 && (
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
                    <OptionCard key={code} selected={form.language === code} onClick={() => update('language', code)} title={label} />
                  ))}
                </div>
              )}

              {/* TRANSLATE_DUB: ngôn ngữ nguồn → đích */}
              {isDub && step === 1 && (
                <div className="space-y-5">
                  <div>
                    <label className="text-sm font-medium text-slate-300 mb-2 block">Ngôn ngữ nguồn</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(SOURCE_LANGUAGES).map(([code, label]) => (
                        <OptionCard key={code} selected={form.sourceLanguage === code} onClick={() => update('sourceLanguage', code)} title={label} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-300 mb-2 block">Dịch sang</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(TARGET_LANGUAGES).map(([code, label]) => (
                        <OptionCard key={code} selected={form.targetLanguage === code} onClick={() => update('targetLanguage', code)} title={label} />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Duration (SUMMARY) */}
              {form.mode === 'SUMMARY' && step === 2 && (
                <div className="grid grid-cols-3 gap-3">
                  {SUMMARY_DURATIONS.map((d) => (
                    <OptionCard key={d.value} selected={form.targetDurationSec === d.value} onClick={() => update('targetDurationSec', d.value)} title={d.label} desc={d.desc} />
                  ))}
                </div>
              )}

              {/* SUMMARY style + tone + spoiler */}
              {form.mode === 'SUMMARY' && step === 3 && (
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-slate-300 mb-2 block">Phong cách review</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(STYLE_LABELS).map(([code, label]) => (
                        <OptionCard key={code} selected={form.style === code} onClick={() => update('style', code)} title={label} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-300 mb-2 block">Giọng điệu (tone)</label>
                    <input value={form.tone} onChange={(e) => update('tone', e.target.value)} placeholder="VD: nghiêm túc, hài hước, sâu sắc..."
                      className="w-full px-4 py-2.5 rounded-xl bg-[#0F1117] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50" />
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={form.spoilerAllowed} onChange={(e) => update('spoilerAllowed', e.target.checked)} className="w-4 h-4 accent-blue-600" />
                    <span className="text-sm text-slate-300">Cho phép tiết lộ chi tiết (spoiler)</span>
                  </label>
                </div>
              )}

              {/* SUMMARY voice */}
              {form.mode === 'SUMMARY' && step === 4 && (
                <VoiceStep form={form} update={update} />
              )}

              {/* TRANSLATE_DUB: chọn 1 trong 12 phong cách dịch */}
              {isDub && step === 2 && (
                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2 block">Phong cách dịch (12 lựa chọn)</label>
                  <div className="grid grid-cols-2 gap-3 max-h-[360px] overflow-y-auto pr-1">
                    {presets.map((p) => (
                      <OptionCard key={p.slug} selected={form.stylePreset === p.slug}
                        onClick={() => update('stylePreset', p.slug)} title={p.name} desc={p.description} />
                    ))}
                  </div>
                </div>
              )}

              {/* TRANSLATE_DUB: lồng tiếng AI bật/tắt */}
              {isDub && step === 3 && (
                <div className="space-y-4">
                  <button onClick={() => update('enableDubbing', !form.enableDubbing)}
                    className={`w-full flex items-center justify-between p-4 rounded-xl border transition ${form.enableDubbing ? 'border-blue-500 bg-blue-500/10' : 'border-white/5 bg-white/[0.02] hover:border-white/15'}`}>
                    <div className="text-left">
                      <div className="flex items-center gap-2 text-sm font-semibold text-white">
                        <AudioLines className="w-4 h-4 text-blue-400" /> Lồng tiếng AI
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {form.enableDubbing ? 'Bật — giọng đọc AI thay thế audio gốc, ép khớp thời gian' : 'Tắt — giữ nguyên âm thanh gốc, chỉ thay phụ đề'}
                      </div>
                    </div>
                    <span className={`relative w-11 h-6 rounded-full transition shrink-0 ${form.enableDubbing ? 'bg-blue-600' : 'bg-white/10'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${form.enableDubbing ? 'translate-x-5' : ''}`} />
                    </span>
                  </button>
                  {form.enableDubbing && <VoiceStep form={form} update={update} />}
                </div>
              )}

              {/* TRANSLATE_DUB: nâng cao — method che chữ + vị trí phụ đề mới */}
              {isDub && step === 4 && (
                <div>
                  <label className="text-sm font-medium text-slate-300 mb-2 block">Cách xử lý phụ đề gốc (hardsub)</label>
                  <div className="space-y-3">
                    {Object.entries(MASK_METHODS).map(([code, m]) => (
                      <OptionCard key={code} selected={form.maskMethod === code} onClick={() => update('maskMethod', code)} title={m.label} desc={m.desc} />
                    ))}
                  </div>

                  <label className="text-sm font-medium text-slate-300 mt-5 mb-2 block">Vị trí phụ đề dịch mới</label>
                  <select
                    value={form.subPosition}
                    onChange={(e) => update('subPosition', e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0F1117] border border-white/10 text-slate-200 focus:outline-none focus:border-blue-500/50">
                    <option value="original">Đè lên vùng đã che (trùng khớp hardsub gốc)</option>
                    <option value="top">Phía trên (safe zone trên)</option>
                    <option value="bottom">Phía dưới (safe zone dưới)</option>
                    <option value="custom">Tuỳ chỉnh (để trống — chỉnh sau trên editor)</option>
                  </select>

                  <p className="text-xs text-slate-500 mt-3 leading-relaxed">
                    Mặc định phụ đề dịch đè lên vùng đã che để thẩm mỹ. Sau khi pipeline quét OCR xong, bạn có thể
                    chỉnh vùng che, độ mờ và vị trí ngay trên trang chi tiết dự án.
                  </p>
                </div>
              )}

              {/* Generate */}
              {(form.mode === 'SUMMARY' && step === 5) || (isDub && step === 5) ? (
                <div>
                  <div className="text-center mb-6">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-600/30">
                      <Wand2 className="w-8 h-8 text-white" />
                    </div>
                    <h3 className="text-lg font-semibold text-white">Sẵn sàng tạo!</h3>
                    <p className="text-sm text-slate-400 mt-1">Kiểm tra cấu hình rồi nhấn tạo để AI chạy pipeline.</p>
                  </div>
                  <div className="space-y-3">
                    <input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder="Tên dự án (tùy chọn)"
                      className="w-full px-4 py-2.5 rounded-xl bg-[#0F1117] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50" />
                    <div className="rounded-xl bg-[#0F1117] border border-white/5 p-4 space-y-2 text-sm">
                      {(isDub
                        ? [
                            ['Chế độ', MODE_LABELS.TRANSLATE_DUB],
                            ['Video', form.sourceFileName],
                            ['Ngôn ngữ', `${SOURCE_LANGUAGES[form.sourceLanguage]} → ${TARGET_LANGUAGES[form.targetLanguage]}`],
                            ['Phong cách dịch', selectedPreset ? `${selectedPreset.name}` : form.stylePreset],
                            ['Lồng tiếng AI', form.enableDubbing ? `Bật (${VOICE_PROVIDER_LABELS[form.voiceProvider] || form.voiceProvider})` : 'Tắt'],
                            ['Che chữ gốc', MASK_METHODS[form.maskMethod]?.label],
                          ]
                        : [
                            ['Chế độ', MODE_LABELS.SUMMARY],
                            ['Ngôn ngữ', LANGUAGE_LABELS[form.language] || form.language],
                            ['Độ dài', form.targetDurationSec >= 60 ? `${Math.round(form.targetDurationSec / 60)} phút` : `${form.targetDurationSec} giây`],
                            ['Phong cách', STYLE_LABELS[form.style] || form.style],
                            ['Giọng đọc', VOICE_PROVIDER_LABELS[form.voiceProvider] || form.voiceProvider],
                          ]
                      ).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between">
                          <span className="text-slate-400">{k}</span>
                          <span className="text-slate-200 font-medium text-right max-w-[60%] truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        <div className="flex items-center justify-between mt-6">
          <button
            onClick={() => (step > 0 ? setStep(step - 1) : update('mode', null))}
            disabled={creating || uploading}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-white disabled:opacity-30 transition"
          >
            <ChevronLeft className="w-4 h-4" /> {step === 0 ? 'Chọn lại' : 'Quay lại'}
          </button>
          {step < steps.length - 1 ? (
            <button
              onClick={() => canNext() && setStep(step + 1)}
              disabled={!canNext() || uploading}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition disabled:opacity-30"
            >
              Tiếp tục <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating || uploading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-semibold transition shadow-lg shadow-blue-600/30 disabled:opacity-50"
            >
              {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> Đang tạo...</> : <><Wand2 className="w-4 h-4" /> Bắt đầu tạo</>}
            </button>
          )}
        </div>
      </div>
    </Layout>
  );
}

// ── Small components ──
function StepIndicator({ steps, step }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-8 overflow-x-auto pb-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1 shrink-0">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition ${i === step ? 'bg-blue-600 text-white' : i < step ? 'bg-blue-500/15 text-blue-400' : 'bg-white/5 text-slate-500'}`}>
            {i < step ? <Check className="w-3 h-3" /> : <s.icon className="w-3 h-3" />}
            <span className="hidden sm:inline">{s.label}</span>
          </div>
          {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-slate-600" />}
        </div>
      ))}
    </div>
  );
}

function OptionCard({ selected, onClick, title, desc, children }) {
  return (
    <button onClick={onClick} className={`text-left p-4 rounded-xl border transition-all w-full ${selected ? 'border-blue-500 bg-blue-500/10' : 'border-white/5 bg-white/[0.02] hover:border-white/15'}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white">{title}</div>
          {desc && <div className="text-xs text-slate-400 mt-0.5">{desc}</div>}
        </div>
        {selected && <Check className="w-4 h-4 text-blue-400 shrink-0 ml-2" />}
      </div>
      {children}
    </button>
  );
}

function ModeCard({ onClick, icon: Icon, title, desc }) {
  return (
    <button onClick={onClick} className="text-left p-6 rounded-2xl border border-white/5 bg-white/[0.02] hover:border-blue-500/30 hover:bg-blue-500/5 transition group">
      <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4 group-hover:bg-blue-500/20 transition">
        <Icon className="w-6 h-6 text-blue-400" />
      </div>
      <div className="text-lg font-semibold text-white">{title}</div>
      <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">{desc}</p>
    </button>
  );
}

function UploadBlock({ label, fileName, onChange, accept, multiple, uploading, hint }) {
  return (
    <div>
      <label className="text-sm font-medium text-slate-300 mb-2 block">{label}</label>
      <label className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-2xl py-8 transition ${uploading ? 'pointer-events-none opacity-60' : 'cursor-pointer'} ${fileName ? 'border-blue-500/40 bg-blue-500/5' : 'border-white/10 hover:border-blue-500/30 bg-white/[0.02]'}`}>
        <Upload className="w-7 h-7 text-slate-400" />
        <span className="text-sm text-slate-300">{fileName || 'Nhấn để chọn tệp'}</span>
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
        {uploading && <Loader2 className="w-5 h-5 animate-spin text-blue-400" />}
        <input type="file" accept={accept} multiple={multiple} onChange={onChange} className="hidden" />
      </label>
    </div>
  );
}

function VoiceStep({ form, update, optional }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium text-slate-300 mb-2 block">{optional ? 'Giọng đọc (tuỳ chọn)' : 'Nhà cung cấp giọng đọc'}</label>
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(VOICE_PROVIDER_LABELS).map(([code, label]) => (
            <OptionCard key={code} selected={form.voiceProvider === code} onClick={() => update('voiceProvider', code)} title={label} />
          ))}
        </div>
      </div>
      <div>
        <label className="text-sm font-medium text-slate-300 mb-2 block">Tên giọng (tuỳ chọn)</label>
        <input value={form.voiceName} onChange={(e) => update('voiceName', e.target.value)} placeholder="VD: Rachel, Adam..."
          className="w-full px-4 py-2.5 rounded-xl bg-[#0F1117] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50" />
      </div>
    </div>
  );
}
