import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronRight, ChevronLeft, Globe, Clock, Palette, Mic, Wand2, Loader2, Upload, Film, Clapperboard, FileText, Languages, AlertCircle, AudioLines, AlertTriangle, Search } from 'lucide-react';
import {
  LANGUAGE_LABELS, STYLE_LABELS, VOICE_PROVIDER_LABELS,
  MODE_LABELS, SOURCE_LANGUAGES, TARGET_LANGUAGES,
  STYLE_PRESETS_FALLBACK,
} from '@/lib/constants';
import { projectsApi } from '@/api/projects';
import { uploadApi } from '@/api/upload';
import { VIDEO_ACCEPT, canonicalVideoMimeType, videoExtension } from '@/lib/videoFiles';
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

const PRESET_CATEGORIES = {
  all: 'Tất cả',
  drama: 'Phim & Kịch tính',
  trend: 'Xu hướng & Meme',
  formal: 'Chuẩn mực & Tin tức',
};

const PRESET_CATEGORY_MAP = {
  'co-trang': 'drama',
  'tinh-cam': 'drama',
  'review-phim': 'drama',
  'kinh-di': 'drama',
  'tre-em': 'drama',
  'bat-trend': 'trend',
  'hai-huoc': 'trend',
  'gaming': 'trend',
  'the-thao': 'trend',
  'sat-nghia': 'formal',
  'tai-lieu': 'formal',
  'chinh-luan': 'formal',
  'cong-nghe': 'formal',
};

export default function CreateProject() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  // R1: resume-session khi rớt mạng — giữ File + controller + sessionId để Hủy/Thử lại.
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadController, setUploadController] = useState(null);
  const [uploadSession, setUploadSession] = useState(null); // { uploadId, fingerprint }
  const [error, setError] = useState('');
  const [presets, setPresets] = useState(STYLE_PRESETS_FALLBACK);
  const [presetCategory, setPresetCategory] = useState('all');
  const [presetSearch, setPresetSearch] = useState('');
  const [copyrightAck, setCopyrightAck] = useState(false);
  // F6: duration video thật cho nhánh dub (probe sau upload). null → FreeTierWarning ẩn.
  const [videoDurationSec, setVideoDurationSec] = useState(null);
  const [scriptUploading, setScriptUploading] = useState(false);
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
    audioMode: 'DUB_MIX',
    voiceProvider: 'elevenlabs',
    voiceName: '',
    subPosition: 'bottom',
    scriptUploadId: null,
    scriptFileName: '',
    scriptCharCount: 0,
    scriptByteSize: 0,
    scriptPreview: '',
    aspectRatio: '16:9',
    burnSubtitles: true,
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
  const scriptSteps = [
    { key: 'script', label: 'Kịch bản', icon: FileText },
    { key: 'config', label: 'Cấu hình video', icon: Palette },
    { key: 'generate', label: 'Tạo video', icon: Wand2 },
  ];
  const steps = form.mode === 'SUMMARY' ? summarySteps : (form.mode === 'SCRIPT_TO_VIDEO' || form.mode === 'AI_VIDEO') ? scriptSteps : dubSteps;

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

  // R1: fingerprint session = name+size+mime — reload trang chọn lại cùng file
  // thì resume đúng session cũ; file khác thì init mới (không resume nhầm).
  const uploadSessionKey = (file) => {
    if (!file) return null;
    try {
      return `upload-session:${file.name}|${file.size}|${canonicalVideoMimeType(videoExtension(file.name))}`;
    } catch {
      return null;
    }
  };

  const clearStaleVideo = () => {
    // Clear stale key — key cũ không dùng được nữa, tránh tạo project với file lỗi.
    update('sourceVideoKey', null);
    update('sourceFileName', null);
    update('videoHash', null);
    setVideoDurationSec(null);
  };

  const startUpload = async (file, { initialUploadId } = {}) => {
    if (!file || uploading) return;
    setError('');
    setUploading(true);
    setUploadPercent(0);
    setVideoDurationSec(null);
    // Probe duration thật từ File (best-effort, không chặn upload nếu lỗi).
    try {
      const objectUrl = URL.createObjectURL(file);
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.src = objectUrl;
      probe.onloadedmetadata = () => {
        if (Number.isFinite(probe.duration) && probe.duration > 0) {
          setVideoDurationSec(Math.round(probe.duration));
        }
        URL.revokeObjectURL(objectUrl);
      };
      probe.onerror = () => URL.revokeObjectURL(objectUrl);
    } catch {
      /* best-effort — giữ null → warning ẩn */
    }
    // Controller mới cho lần upload này; controller cũ đã settle nên không abort
    // (abort sẽ kích hoạt DELETE session đang muốn resume).
    const controller = new AbortController();
    setUploadController(controller);
    const key = uploadSessionKey(file);
    let storedId = initialUploadId || null;
    if (!storedId && key) {
      try {
        const raw = sessionStorage.getItem(key);
        storedId = raw ? JSON.parse(raw)?.uploadId || null : null;
      } catch {
        storedId = null;
      }
    }
    try {
      const res = await uploadApi.upload(file, {
        onProgress: setUploadPercent,
        signal: controller.signal,
        initialUploadId: storedId || undefined,
        onUploadId: (id) => {
          setUploadSession({ uploadId: id, fingerprint: key });
          if (key) {
            try { sessionStorage.setItem(key, JSON.stringify({ uploadId: id })); } catch { /* private mode */ }
          }
        },
      });
      update('sourceVideoKey', res.key ?? res.storageKey ?? null);
      update('sourceFileName', file.name);
      update('videoHash', res.videoHash || null);
      if (key) {
        try { sessionStorage.removeItem(key); } catch { /* ignore */ }
      }
      setUploadSession(null);
    } catch (err) {
      const aborted = err?.name === 'AbortError' || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
      if (aborted) {
        // DELETE session best-effort đã bắn — giữ file + session để Thử lại resume.
        setError('Đã hủy tải lên — bấm Thử lại để tiếp tục từ chỗ đã dừng.');
      } else if (err?.fatalUpload) {
        if (key) {
          try { sessionStorage.removeItem(key); } catch { /* ignore */ }
        }
        setUploadSession(null);
        clearStaleVideo();
        setUploadPercent(0);
        setError('Phiên tải đã hết hạn — bấm Thử lại để tải mới từ đầu.');
      } else {
        clearStaleVideo();
        setError('Tải phim thất bại: ' + (err?.response?.data?.message || err?.response?.data?.error?.message || err.message));
        setUploadPercent(0);
        // Giữ uploadSession (nếu có) để nút Thử lại resume cùng session.
      }
    } finally {
      setUploading(false);
      setUploadController(null);
    }
  };

  const handleMovie = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setUploadSession(null);
    await startUpload(file);
  };

  const handleCancelUpload = () => {
    uploadController?.abort?.();
  };

  const handleScriptFile = async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!['.txt', '.md'].includes(ext)) {
      setError('Chỉ hỗ trợ file kịch bản định dạng .txt hoặc .md');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('File kịch bản không được vượt quá 2MB');
      return;
    }
    setScriptUploading(true);
    setError('');
    try {
      const res = await projectsApi.uploadScript(file);
      update('scriptUploadId', res.id);
      update('scriptFileName', res.filename);
      update('scriptCharCount', res.charCount);
      update('scriptByteSize', res.byteSize);
      update('scriptPreview', res.preview);
      if (!form.title) {
        update('title', res.filename.replace(/\.[^/.]+$/, ''));
      }
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Lỗi tải lên kịch bản');
    } finally {
      setScriptUploading(false);
    }
  };

  const handleRetryUpload = () => {
    if (!selectedFile || uploading) return;
    setError('');
    startUpload(selectedFile, { initialUploadId: uploadSession?.uploadId || undefined });
  };

  const canNext = () => {
    if (form.mode === 'SUMMARY') {
      if (step === 0) return !!form.sourceVideoKey;
      // B3 Option A: gate bước ngôn ngữ = đã có video (BE bắt buộc sourceVideoKey,
      // projects.js:49). Check cũ !!language luôn true (default 'vi') là gate giả.
      if (step === 1) return !!form.sourceVideoKey;
      if (step === 2) return !!form.targetDurationSec;
      if (step === 3) return !!form.style;
      if (step === 4) return !!form.voiceProvider;
      return true;
    }
    if (step === 0) return !!form.sourceVideoKey && !uploading;
    if (step === 1) {
      if (!form.targetLanguage) return false;
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
      if (form.mode === 'TRANSLATE_DUB' && !form.stylePreset) {
        setError('Vui lòng chọn phong cách dịch thuật (Style Preset) trước khi tạo dự án.');
        setCreating(false);
        return;
      }
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
        const isDub = Boolean(form.enableDubbing);
        payload = {
          mode: 'TRANSLATE_DUB',
          title: form.title.trim() || 'Video Việt hoá mới',
          sourceLanguage: form.sourceLanguage || 'auto',
          targetLanguage: form.targetLanguage || 'vi',
          stylePreset: form.stylePreset,
          enableDubbing: isDub,
          audioMode: isDub ? (form.audioMode || 'DUB_MIX') : 'ORIGINAL_ONLY',
          subPosition: form.subPosition || 'bottom',
          sourceVideoKey: form.sourceVideoKey,
          videoHash: form.videoHash,
          copyrightAcknowledged: copyrightAck,
          params: isDub
            ? {
                stylePreset: form.stylePreset,
                sourceLanguage: form.sourceLanguage || 'auto',
                targetLanguage: form.targetLanguage || 'vi',
                enableDubbing: true,
                audioMode: form.audioMode || 'DUB_MIX',
                voiceProvider: form.voiceProvider,
                voiceName: form.voiceName,
                subPosition: form.subPosition || 'bottom',
              }
            : {
                stylePreset: form.stylePreset,
                sourceLanguage: form.sourceLanguage || 'auto',
                targetLanguage: form.targetLanguage || 'vi',
                enableDubbing: false,
                audioMode: 'ORIGINAL_ONLY',
                subPosition: form.subPosition || 'bottom',
              },
        };
      }
      const project = await projectsApi.create(payload);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      const respData = err?.response?.data;
      const field = respData?.field || respData?.error?.field;
      const errMsg = respData?.message || respData?.error?.message || err.message;
      const displayMsg = field ? `[Trường ${field}] ${errMsg}` : errMsg;
      setError('Không thể tạo dự án: ' + displayMsg);
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <ModeCard
              onClick={() => {
                update('mode', 'SCRIPT_TO_VIDEO');
                update('aspectRatio', '16:9');
                update('voiceProvider', 'edge_tts');
                update('burnSubtitles', true);
              }}
              icon={FileText}
              title="Tạo Video Từ Kịch Bản"
              desc="Tải kịch bản TXT/MD, AI tự động phân đoạn ngữ nghĩa, sinh giọng đọc và tạo slide video hoàn chỉnh."
            />
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
  const isScript = form.mode === 'SCRIPT_TO_VIDEO' || form.mode === 'AI_VIDEO';
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
              {isScript && step === 0 && (
                <div className="space-y-4">
                  <div className="rounded-xl border-2 border-dashed border-border/80 hover:border-primary/50 transition p-6 text-center">
                    <input
                      type="file"
                      id="script-file-input"
                      accept=".txt,.md"
                      onChange={handleScriptFile}
                      className="hidden"
                    />
                    <label htmlFor="script-file-input" className="cursor-pointer block">
                      <FileText className="w-10 h-10 text-primary mx-auto mb-2" />
                      <span className="text-sm font-semibold text-foreground block">
                        {form.scriptFileName || 'Chọn file kịch bản (.txt, .md)'}
                      </span>
                      <span className="text-xs text-muted-foreground mt-1 block">
                        Tối đa 2MB và 60.000 ký tự UTF-8
                      </span>
                    </label>
                  </div>
                  {scriptUploading && (
                    <div className="flex items-center justify-center gap-2 text-sm text-primary py-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Đang đọc và kiểm tra kịch bản...</span>
                    </div>
                  )}
                  {form.scriptUploadId && (
                    <div className="rounded-xl bg-muted/40 border border-border p-4 space-y-2 text-left">
                      <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
                        <span>Tệp: <strong className="text-foreground">{form.scriptFileName}</strong></span>
                        <span>{form.scriptCharCount?.toLocaleString()} ký tự ({Math.round((form.scriptByteSize || 0) / 1024)} KB)</span>
                      </div>
                      {form.scriptPreview && (
                        <div className="p-3 bg-background rounded-lg border border-border text-xs text-muted-foreground font-mono max-h-36 overflow-y-auto whitespace-pre-wrap">
                          {form.scriptPreview}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {isScript && step === 1 && (
                <div className="space-y-5 text-left">
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">
                      1. Tỉ lệ khung hình video
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <OptionCard
                        selected={form.aspectRatio === '16:9'}
                        onClick={() => update('aspectRatio', '16:9')}
                        title="16:9 (Ngang)"
                        desc="Phù hợp YouTube, Facebook, Web"
                      />
                      <OptionCard
                        selected={form.aspectRatio === '9:16'}
                        onClick={() => update('aspectRatio', '9:16')}
                        title="9:16 (Dọc)"
                        desc="Phù hợp TikTok, Reels, Shorts"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">
                      2. Nhà cung cấp giọng đọc (TTS)
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <OptionCard
                        selected={form.voiceProvider === 'edge_tts'}
                        onClick={() => update('voiceProvider', 'edge_tts')}
                        title="Edge-TTS"
                        desc="Miễn phí, giọng đọc mượt mà tự nhiên"
                      />
                      <OptionCard
                        selected={form.voiceProvider === 'elevenlabs'}
                        onClick={() => update('voiceProvider', 'elevenlabs')}
                        title="ElevenLabs"
                        desc="Giọng đọc AI cao cấp biểu cảm"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-muted/40 border border-border">
                    <div>
                      <span className="text-sm font-medium text-foreground block">Đóng dấu phụ đề vào video (Burn-in Subtitles)</span>
                      <span className="text-xs text-muted-foreground">Ghép phụ đề trực tiếp vào MP4 bằng định dạng ASS</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={form.burnSubtitles !== false}
                      onChange={(e) => update('burnSubtitles', e.target.checked)}
                      className="w-4 h-4 rounded text-primary focus:ring-primary"
                    />
                  </div>
                </div>
              )}

              {isScript && step === 2 && (
                <div className="space-y-4 text-left">
                  <div>
                    <label className="text-sm font-semibold text-foreground mb-1 block">Tiêu đề video</label>
                    <input
                      type="text"
                      value={form.title}
                      onChange={(e) => update('title', e.target.value)}
                      placeholder="Nhập tên dự án..."
                      className="w-full px-3.5 py-2.5 rounded-xl bg-background border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </div>
                  <div className="rounded-xl bg-muted/40 border border-border p-4 space-y-2 text-xs text-muted-foreground">
                    <div className="flex justify-between"><span>Kịch bản:</span><strong className="text-foreground">{form.scriptFileName}</strong></div>
                    <div className="flex justify-between"><span>Độ dài:</span><strong className="text-foreground">{form.scriptCharCount?.toLocaleString()} ký tự</strong></div>
                    <div className="flex justify-between"><span>Tỉ lệ:</span><strong className="text-foreground">{form.aspectRatio}</strong></div>
                    <div className="flex justify-between"><span>Giọng đọc:</span><strong className="text-foreground">{form.voiceProvider}</strong></div>
                    <div className="flex justify-between"><span>Phụ đề:</span><strong className="text-foreground">{form.burnSubtitles !== false ? 'Có (Burn-in ASS)' : 'Không'}</strong></div>
                  </div>
                  <div className="flex items-start gap-2 pt-2">
                    <input
                      type="checkbox"
                      id="script-copyright-ack"
                      checked={copyrightAck}
                      onChange={(e) => setCopyrightAck(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded text-primary focus:ring-primary"
                    />
                    <label htmlFor="script-copyright-ack" className="text-xs text-muted-foreground cursor-pointer">
                      Tôi xác nhận nội dung kịch bản tuân thủ quyền sở hữu trí tuệ và điều khoản dịch vụ.
                    </label>
                  </div>
                </div>
              )}

              {form.mode === 'SUMMARY' && step === 0 && (
                <div className="space-y-4">
                  <UploadBlock
                    label="Tải phim cần review (2–3 tiếng)"
                    fileName={form.sourceFileName}
                    onChange={handleMovie}
                    accept={VIDEO_ACCEPT}
                    uploading={uploading}
                    hint="Định dạng MP4, MOV, M4V, MKV, WebM · tự tiếp tục khi mất mạng"
                  />
                  <UploadStatus
                    uploading={uploading}
                    uploadPercent={uploadPercent}
                    canRetry={!uploading && !!selectedFile && !form.sourceVideoKey}
                    onCancel={handleCancelUpload}
                    onRetry={handleRetryUpload}
                  />
                </div>
              )}

              {isDub && step === 0 && (
                <div className="space-y-4">
                  <UploadBlock
                    label="Tải video cần Việt hoá (tối đa 2GB)"
                    fileName={form.sourceFileName}
                    onChange={handleMovie}
                    accept={VIDEO_ACCEPT}
                    uploading={uploading}
                    hint="MP4, MOV, M4V, MKV, WebM · tự tiếp tục khi mất mạng"
                  />
                  <UploadStatus
                    uploading={uploading}
                    uploadPercent={uploadPercent}
                    canRetry={!uploading && !!selectedFile && !form.sourceVideoKey}
                    onCancel={handleCancelUpload}
                    onRetry={handleRetryUpload}
                  />
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
                  {/* Language Flow Preview */}
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-muted/40 border border-border">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-primary" />
                      <span className="text-xs text-muted-foreground">Video nguồn:</span>
                      <span className="text-xs font-semibold text-foreground">
                        {SOURCE_LANGUAGES[form.sourceLanguage] || form.sourceLanguage}
                      </span>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Dịch sang:</span>
                      <span className="text-xs font-semibold text-primary">
                        {TARGET_LANGUAGES[form.targetLanguage] || form.targetLanguage}
                      </span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">
                      1. Ngôn ngữ gốc trong video
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(SOURCE_LANGUAGES).map(([code, label]) => (
                        <OptionCard key={code} selected={form.sourceLanguage === code} onClick={() => update('sourceLanguage', code)} title={label} />
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-semibold text-foreground mb-2 block">
                      2. Ngôn ngữ bản dịch mong muốn
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(TARGET_LANGUAGES).map(([code, label]) => (
                        <OptionCard key={code} selected={form.targetLanguage === code} onClick={() => update('targetLanguage', code)} title={label} />
                      ))}
                    </div>
                  </div>
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
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <div>
                      <label className="text-sm font-semibold text-foreground block">
                        Phong cách dịch (13 phong cách chuyên nghiệp)
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Chọn phong cách câu từ phù hợp nhất với thể loại video của bạn
                      </p>
                    </div>
                    {form.stylePreset && (
                      <span className="text-[11px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded shrink-0 self-start sm:self-auto">
                        Đã chọn: {presets.find((p) => p.slug === form.stylePreset)?.name || form.stylePreset}
                      </span>
                    )}
                  </div>

                  {/* Search and Category Filter Toolbar */}
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={presetSearch}
                        onChange={(e) => setPresetSearch(e.target.value)}
                        placeholder="Tìm phong cách (cổ trang, meme, tài liệu, phim...)..."
                        className="w-full pl-8 pr-7 py-1.5 text-xs rounded-xl bg-background border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      {presetSearch && (
                        <button
                          type="button"
                          onClick={() => setPresetSearch('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
                      {Object.entries(PRESET_CATEGORIES).map(([catKey, catLabel]) => (
                        <button
                          key={catKey}
                          type="button"
                          onClick={() => setPresetCategory(catKey)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                            presetCategory === catKey
                              ? 'bg-primary text-primary-foreground shadow-xs'
                              : 'bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted'
                          }`}
                        >
                          {catLabel}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Presets Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[340px] overflow-y-auto pr-1">
                    {presets
                      .filter((p) => {
                        if (presetCategory !== 'all') {
                          const cat = PRESET_CATEGORY_MAP[p.slug];
                          if (cat !== presetCategory) return false;
                        }
                        if (presetSearch.trim()) {
                          const q = presetSearch.toLowerCase().trim();
                          const n = (p.name || '').toLowerCase();
                          const d = (p.description || '').toLowerCase();
                          if (!n.includes(q) && !d.includes(q)) return false;
                        }
                        return true;
                      })
                      .map((p) => (
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
                  <div>
                    <label className="text-sm font-semibold text-foreground block">
                      Tuỳ chọn âm thanh & Lồng tiếng
                    </label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Bạn có muốn AI tạo giọng đọc thay thế lời thoại gốc hay chỉ giữ tiếng gốc và thêm phụ đề?
                    </p>
                  </div>

                  {/* 2-Option Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => update('enableDubbing', false)}
                      className={`p-4 rounded-xl border text-left transition-all flex flex-col justify-between ${
                        !form.enableDubbing
                          ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/30'
                          : 'border-border bg-card hover:bg-muted/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-foreground">Chỉ dịch phụ đề</span>
                          <span className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                            !form.enableDubbing ? 'border-primary bg-primary' : 'border-muted-foreground'
                          }`}>
                            {!form.enableDubbing && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Giữ nguyên âm thanh và giọng nói gốc của video, chỉ tạo và ép phụ đề tiếng Việt.
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => update('enableDubbing', true)}
                      className={`p-4 rounded-xl border text-left transition-all flex flex-col justify-between ${
                        form.enableDubbing
                          ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/30'
                          : 'border-border bg-card hover:bg-muted/40'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-primary flex items-center gap-1.5">
                            <AudioLines className="w-3.5 h-3.5" /> Lồng tiếng AI khớp nhịp
                          </span>
                          <span className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                            form.enableDubbing ? 'border-primary bg-primary' : 'border-muted-foreground'
                          }`}>
                            {form.enableDubbing && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Giọng đọc AI thay thế âm thanh thoại gốc, tự động co giãn tốc độ để khớp chính xác nhịp điệu.
                        </p>
                      </div>
                    </button>
                  </div>

                  {form.enableDubbing && (
                    <div className="pt-2 border-t border-border space-y-3">
                      {/* Chế độ âm thanh: DUB_MIX (voice-over + ducking) / DUB_REPLACE (thay hoàn toàn) */}
                      <div>
                        <label className="text-xs font-bold text-foreground block mb-2">
                          Chế độ âm thanh
                        </label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {[
                            { value: 'DUB_MIX', title: 'Lồng tiếng + nền gốc', desc: 'Giọng AI nổi trên nhạc/tiếng động gốc (tự ducking khi nói).' },
                            { value: 'DUB_REPLACE', title: 'Thay thế hoàn toàn', desc: 'Bỏ tiếng gốc, chỉ giữ giọng AI trên nền im lặng.' },
                          ].map((m) => (
                            <button
                              key={m.value}
                              type="button"
                              onClick={() => update('audioMode', m.value)}
                              className={`p-3 rounded-xl border text-left transition-all ${
                                (form.audioMode || 'DUB_MIX') === m.value
                                  ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                                  : 'border-border bg-card hover:bg-muted/40'
                              }`}
                            >
                              <div className="text-xs font-bold text-foreground">{m.title}</div>
                              <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{m.desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                      <VoiceStep form={form} update={update} />
                    </div>
                  )}
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

                  {/* F6: nhánh dub dùng duration video thật (null → ẩn), tránh warning oan từ default 1500 của SUMMARY. */}
                  <FreeTierWarning mode={form.mode} estimatedDuration={isDub ? videoDurationSec : form.targetDurationSec} />

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
                            ...(form.enableDubbing ? [['Chế độ âm thanh', form.audioMode === 'DUB_REPLACE' ? 'Thay thế hoàn toàn' : 'Lồng tiếng + nền gốc']] : []),
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
            type="button"
            onClick={() => (step > 0 ? setStep(step - 1) : update('mode', null))}
            disabled={creating || uploading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>{step === 0 ? 'Chọn lại chế độ' : 'Quay lại'}</span>
          </button>
          {step < steps.length - 1 ? (
            <button
              type="button"
              onClick={() => canNext() && setStep(step + 1)}
              disabled={!canNext() || uploading}
              title={uploading ? 'Đang tải video lên — chờ hoàn tất' : !canNext() ? 'Hoàn tất bước hiện tại (tải video / chọn ngôn ngữ / preset) để tiếp tục' : 'Tiếp tục'}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs sm:text-sm font-semibold transition-colors disabled:opacity-40 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>Tiếp tục</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              title={!copyrightAck ? 'Xác nhận quyền sử dụng nội dung nguồn để tiếp tục' : uploading ? 'Đang tải video lên — chờ hoàn tất' : 'Bắt đầu tạo dự án'}
              disabled={creating || uploading || !copyrightAck}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs sm:text-sm font-semibold transition-colors shadow-xs disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
// R1: tiến trình upload + nút Hủy (giữa chừng) / Thử lại (resume cùng session).
function UploadStatus({ uploading, uploadPercent, canRetry, onCancel, onRetry }) {
  if (!uploading && !canRetry) return null;
  return (
    <div className="space-y-1.5">
      {uploading && (
        <>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">{uploadPercent}% — rớt mạng sẽ tự tiếp tục</p>
            <button
              type="button"
              onClick={onCancel}
              className="text-xs font-semibold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
            >
              Hủy tải lên
            </button>
          </div>
        </>
      )}
      {!uploading && canRetry && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>Thử lại (tiếp tục từ chỗ đã dừng)</span>
          </button>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ steps, step }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-6 sm:mb-8 overflow-x-auto pb-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1 shrink-0">
          <div
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              i === step
                ? 'bg-primary text-primary-foreground shadow-xs'
                : i < step
                ? 'bg-primary/10 text-primary'
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
      className={`text-left p-3.5 rounded-lg border transition-colors w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        selected
          ? 'border-primary bg-primary/10 text-foreground font-semibold shadow-xs'
          : 'border-border bg-card hover:bg-muted/40 hover:border-border/90'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs sm:text-sm font-semibold text-foreground">{title}</div>
          {desc && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed font-normal">{desc}</div>}
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
      className="text-left p-5 sm:p-6 rounded-xl border border-border bg-card hover:border-primary/50 hover:bg-primary/[0.03] transition-all group shadow-xs hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center mb-3.5 group-hover:scale-105 transition-transform">
        <Icon className="w-5 h-5" />
      </div>
      <div className="text-base sm:text-lg font-bold text-foreground group-hover:text-primary transition-colors">{title}</div>
      <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 leading-relaxed">{desc}</p>
    </button>
  );
}

function UploadBlock({ label, fileName, onChange, accept, multiple, uploading, hint }) {
  return (
    <div>
      <label className="text-xs sm:text-sm font-semibold text-foreground mb-2 block">{label}</label>
      <label
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 sm:py-10 transition-colors ${
          uploading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
        } ${
          fileName
            ? 'border-primary/50 bg-primary/5'
            : 'border-border hover:border-border/90 bg-muted/20'
        }`}
      >
        <Upload className="w-7 h-7 text-primary/70" />
        <span className="text-xs sm:text-sm font-semibold text-foreground text-center px-4">{fileName || 'Nhấn hoặc kéo thả tệp video vào đây'}</span>
        {hint && <span className="text-xs text-muted-foreground text-center px-4">{hint}</span>}
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
        <label className="text-xs sm:text-sm font-semibold text-foreground mb-2 block">
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
        <label className="text-xs sm:text-sm font-semibold text-foreground mb-2 block">Tên giọng / Voice ID (tuỳ chọn)</label>
        <input
          value={form.voiceName}
          onChange={(e) => update('voiceName', e.target.value)}
          placeholder="VD: Rachel, Adam, Josh..."
          className="w-full px-3.5 py-2 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
    </div>
  );
}
