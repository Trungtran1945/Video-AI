export const STATUS_LABELS = {
    draft: { label: 'Bản nháp', color: 'bg-slate-500/15 text-slate-400' },
    queued: { label: 'Đang chờ', color: 'bg-yellow-500/15 text-yellow-400' },
    generating: { label: 'Đang tạo', color: 'bg-blue-500/15 text-blue-400' },
    completed: { label: 'Hoàn thành', color: 'bg-emerald-500/15 text-emerald-400' },
    failed: { label: 'Lỗi', color: 'bg-red-500/15 text-red-400' },
    cancelled: { label: 'Đã hủy', color: 'bg-slate-500/15 text-slate-400' },
    pending: { label: 'Chờ xử lý', color: 'bg-yellow-500/15 text-yellow-400' },
    running: { label: 'Đang chạy', color: 'bg-blue-500/15 text-blue-400' },
    retrying: { label: 'Đang thử lại', color: 'bg-orange-500/15 text-orange-400' },
    success: { label: 'Thành công', color: 'bg-emerald-500/15 text-emerald-400' },
    error: { label: 'Lỗi', color: 'bg-red-500/15 text-red-400' },
    timeout: { label: 'Quá hạn', color: 'bg-orange-500/15 text-orange-400' },
  };
  
  export const STAGE_LABELS = {
    // SUMMARY pipeline
    'summary.transcribe': { label: 'Transcript phim', icon: 'FileText' },
    'summary.sceneDetect': { label: 'Nhận diện cảnh', icon: 'Scissors' },
    'summary.analyze': { label: 'Phân tích nội dung', icon: 'Sparkles' },
    'summary.script': { label: 'Viết kịch bản review', icon: 'FileText' },
    'summary.align': { label: 'Khớp cảnh - lời', icon: 'Combine' },
    'summary.tts': { label: 'Tạo giọng đọc', icon: 'Mic' },
    'summary.subtitle': { label: 'Phụ đề', icon: 'Captions' },
    'summary.render': { label: 'Xuất video', icon: 'Video' },
    // STYLE_EDIT pipeline
    'style.analyze': { label: 'Phân tích mẫu', icon: 'Sparkles' },
    'style.storyboard': { label: 'Dàn dựng', icon: 'Clapperboard' },
    'style.tts': { label: 'Tạo giọng đọc', icon: 'Mic' },
    'style.render': { label: 'Xuất video', icon: 'Video' },
  };

  export const STAGE_ORDER = ['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render', 'style.analyze', 'style.storyboard', 'style.tts', 'style.render'];
  
  export const LANGUAGE_LABELS = {
    vi: 'Tiếng Việt',
    en: 'Tiếng Anh',
    es: 'Tiếng Tây Ban Nha',
    fr: 'Tiếng Pháp',
    de: 'Tiếng Đức',
    ja: 'Tiếng Nhật',
    ko: 'Tiếng Hàn',
    zh: 'Tiếng Trung',
  };
  
  export const STYLE_LABELS = {
    cinematic: 'Điện ảnh',
    anime: 'Anime',
    realistic: 'Tả thực',
    cartoon: 'Hoạt hình',
    documentary: 'Phim tài liệu',
    minimalist: 'Tối giản',
  };
  
  export const VOICE_PROVIDER_LABELS = {
    elevenlabs: 'ElevenLabs',
    google_tts: 'Google TTS',
    azure_speech: 'Azure Speech',
    openai_tts: 'OpenAI TTS',
  };
  
  export const LLM_PROVIDERS = ['gemini', 'openai', 'anthropic', 'huggingface'];
  export const IMAGE_PROVIDERS = ['flux', 'stable_diffusion', 'google_image', 'huggingface_inference'];
  export const VIDEO_PROVIDERS = ['kling', 'hailuo', 'pixverse', 'runway', 'luma'];
  export const VOICE_PROVIDERS = ['elevenlabs', 'google_tts', 'azure_speech', 'openai_tts'];
  export const SUBTITLE_PROVIDERS = ['whisper', 'openai_whisper', 'faster_whisper'];
  
  export function StatusBadge({ status }) {
    const cfg = STATUS_LABELS[status] || { label: status, color: 'bg-slate-500/15 text-slate-400' };
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
        {cfg.label}
      </span>
    );
  }
  
  export function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  
  export function formatDuration(ms) {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }