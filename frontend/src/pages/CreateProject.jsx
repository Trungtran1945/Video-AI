import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronRight, ChevronLeft, Globe, Clock, Palette, Mic, Wand2, Loader2, Upload, Film, Clapperboard, Scissors, AlertCircle } from 'lucide-react';
import { LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS } from '@/lib/constants';
import { projectsApi } from '@/api/projects';
import { uploadApi } from '@/api/upload';
import Layout from '@/components/Layout';

const STYLE_EDIT_DURATIONS = [
  { value: 30, label: '30 giây', desc: 'Rất ngắn' },
  { value: 45, label: '45 giây', desc: 'Tiêu chuẩn' },
  { value: 60, label: '60 giây', desc: 'Dài' },
];

const SUMMARY_DURATIONS = [
  { value: 1200, label: '20 phút', desc: 'Ngắn gọn' },
  { value: 1500, label: '25 phút', desc: 'Tiêu chuẩn' },
  { value: 1800, label: '30 phút', desc: 'Chi tiết' },
];

function kindOf(file) {
  if (file.type.startsWith('image')) return 'image';
  if (file.type.startsWith('video')) return 'video';
  if (file.type.startsWith('audio')) return 'audio';
  return 'unknown';
}

export default function CreateProject() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    mode: null, // 'SUMMARY' | 'STYLE_EDIT'
    title: '',
    sourceVideoKey: null,
    sourceFileName: '',
    language: 'vi',
    targetDurationSec: 1500,
    style: 'cinematic',
    tone: '',
    spoilerAllowed: false,
    voiceProvider: 'elevenlabs',
    voiceName: '',
    assets: [], // { storageKey, kind, name }
    templateVideoKey: null,
    templateFileName: '',
    aspectRatio: '9:16',
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
  const styleSteps = [
    { key: 'assets', label: 'Assets', icon: Upload },
    { key: 'duration', label: 'Độ dài', icon: Clock },
    { key: 'style', label: 'Phong cách', icon: Palette },
    { key: 'generate', label: 'Tạo', icon: Wand2 },
  ];
  const steps = form.mode === 'SUMMARY' ? summarySteps : styleSteps;

  // ── Upload handlers ──
  const uploadFile = async (file) => {
    setUploading(true);
    try {
      const res = await uploadApi.upload(file);
      return res;
    } finally {
      setUploading(false);
    }
  };

  const handleMovie = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const res = await uploadFile(file);
      update('sourceVideoKey', res.key);
      update('sourceFileName', file.name);
    } catch (err) {
      setError('Tải phim thất bại: ' + (err?.response?.data?.message || err.message));
    }
  };

  const handleTemplate = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const res = await uploadFile(file);
      update('templateVideoKey', res.key);
      update('templateFileName', file.name);
    } catch (err) {
      setError('Tải video mẫu thất bại: ' + (err?.response?.data?.message || err.message));
    }
  };

  const handleAssets = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setError('');
    try {
      const uploaded = [];
      for (const f of files) {
        const res = await uploadFile(f);
        uploaded.push({ storageKey: res.key, kind: kindOf(f), name: f.name });
      }
      update('assets', [...form.assets, ...uploaded]);
    } catch (err) {
      setError('Tải assets thất bại: ' + (err?.response?.data?.message || err.message));
    }
  };

  const removeAsset = (idx) => update('assets', form.assets.filter((_, i) => i !== idx));

  // ── Validation ──
  const canNext = () => {
    if (form.mode === 'SUMMARY') {
      if (step === 0) return !!form.sourceVideoKey;
      if (step === 1) return !!form.language;
      if (step === 2) return !!form.targetDurationSec;
      if (step === 3) return !!form.style;
      if (step === 4) return !!form.voiceProvider;
      return true;
    } else {
      if (step === 0) return form.assets.length > 0 && !!form.templateVideoKey;
      if (step === 1) return !!form.targetDurationSec;
      if (step === 2) return !!form.style;
      return true;
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const title = form.title.trim() || (form.mode === 'SUMMARY' ? 'Review phim mới' : 'Video edit theo mẫu');
      let payload;
      if (form.mode === 'SUMMARY') {
        payload = {
          mode: 'SUMMARY',
          title,
          language: form.language,
          style: form.style,
          targetDurationSec: form.targetDurationSec,
          sourceVideoKey: form.sourceVideoKey,
          params: { tone: form.tone, spoilerAllowed: form.spoilerAllowed, voiceProvider: form.voiceProvider, voiceName: form.voiceName },
        };
      } else {
        payload = {
          mode: 'STYLE_EDIT',
          title,
          language: form.language,
          style: form.style,
          targetDurationSec: form.targetDurationSec,
          aspectRatio: form.aspectRatio,
          templateVideoKey: form.templateVideoKey,
          assets: form.assets.map((a) => ({ storageKey: a.storageKey, kind: a.kind })),
          params: { tone: form.tone, voiceProvider: form.voiceProvider, voiceName: form.voiceName },
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
              onClick={() => update('mode', 'STYLE_EDIT')}
              icon={Scissors}
              title="Edit Theo Mẫu"
              desc="Upload ảnh/video/âm thanh + video mẫu, AI dựng video 30s–1phút mang phong cách của video mẫu."
            />
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-2xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">
            {form.mode === 'SUMMARY' ? 'Review Phim' : 'Edit Theo Mẫu'}
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

              {/* STYLE_EDIT: assets + template */}
              {form.mode === 'STYLE_EDIT' && step === 0 && (
                <div className="space-y-5">
                  <UploadBlock label="Assets (ảnh / video / âm thanh)" fileName={form.assets.length ? `${form.assets.length} tệp` : ''}
                    onChange={handleAssets} accept="image/*,video/*,audio/*" multiple uploading={uploading} hint="Chọn nhiều tệp cùng lúc" />
                  {form.assets.length > 0 && (
                    <div className="space-y-2">
                      {form.assets.map((a, i) => (
                        <div key={i} className="flex items-center justify-between text-sm bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2">
                          <span className="text-slate-300 truncate">{a.name} <span className="text-slate-500">({a.kind})</span></span>
                          <button onClick={() => removeAsset(i)} className="text-red-400 hover:text-red-300 text-xs">Xoá</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <UploadBlock label="Video mẫu (phong cách tham chiếu)" fileName={form.templateFileName}
                    onChange={handleTemplate} accept="video/*" uploading={uploading} hint="AI sẽ học phong cách từ video này" />
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

              {/* Duration */}
              {(form.mode === 'SUMMARY' && step === 2) || (form.mode === 'STYLE_EDIT' && step === 1) ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    {(form.mode === 'SUMMARY' ? SUMMARY_DURATIONS : STYLE_EDIT_DURATIONS).map((d) => (
                      <OptionCard key={d.value} selected={form.targetDurationSec === d.value} onClick={() => update('targetDurationSec', d.value)} title={d.label} desc={d.desc} />
                    ))}
                  </div>
                  {form.mode === 'STYLE_EDIT' && (
                    <div>
                      <label className="text-sm font-medium text-slate-300 mb-2 block">Tỷ lệ khung hình</label>
                      <div className="grid grid-cols-2 gap-3">
                        <OptionCard selected={form.aspectRatio === '9:16'} onClick={() => update('aspectRatio', '9:16')} title="9:16 (Shorts)" />
                        <OptionCard selected={form.aspectRatio === '1:1'} onClick={() => update('aspectRatio', '1:1')} title="1:1 (Square)" />
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

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

              {/* STYLE_EDIT style + voice */}
              {form.mode === 'STYLE_EDIT' && step === 2 && (
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-slate-300 mb-2 block">Phong cách dựng</label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(STYLE_LABELS).map(([code, label]) => (
                        <OptionCard key={code} selected={form.style === code} onClick={() => update('style', code)} title={label} />
                      ))}
                    </div>
                  </div>
                  <VoiceStep form={form} update={update} optional />
                </div>
              )}

              {/* Generate */}
              {(form.mode === 'SUMMARY' && step === 5) || (form.mode === 'STYLE_EDIT' && step === 3) ? (
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
                      {[
                        ['Chế độ', form.mode === 'SUMMARY' ? 'Review phim' : 'Edit theo mẫu'],
                        ['Ngôn ngữ', LANGUAGE_LABELS[form.language] || form.language],
                        ['Độ dài', form.targetDurationSec >= 60 ? `${Math.round(form.targetDurationSec / 60)} phút` : `${form.targetDurationSec} giây`],
                        ['Phong cách', STYLE_LABELS[form.style] || form.style],
                        form.mode === 'STYLE_EDIT' ? ['Tỷ lệ', form.aspectRatio] : null,
                        ['Giọng đọc', VOICE_PROVIDER_LABELS[form.voiceProvider] || form.voiceProvider],
                      ].filter(Boolean).map(([k, v]) => (
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
        {selected && <Check className="w-4 h-4 text-blue-400" />}
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
        <label className="text-sm font-medium text-slate-300 mb-2 block">{optional ? 'Giọng đọc (tuỳ chọn)' : 'Giọng đọc'}</label>
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
