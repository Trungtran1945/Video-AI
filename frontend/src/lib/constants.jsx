export const STATUS_LABELS = {
    draft: { label: 'Bản nháp', color: 'bg-muted text-muted-foreground border border-border/80' },
    queued: { label: 'Đang chờ', color: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20' },
    generating: { label: 'Đang tạo', color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/20' },
    completed: { label: 'Hoàn thành', color: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20' },
    failed: { label: 'Lỗi', color: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/20' },
    cancelled: { label: 'Đã hủy', color: 'bg-muted text-muted-foreground border border-border/80' },
    pending: { label: 'Chờ xử lý', color: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20' },
    running: { label: 'Đang chạy', color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/20' },
    retrying: { label: 'Đang thử lại', color: 'bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-500/20' },
    retry: { label: 'Đang chờ retry', color: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/20' },
    success: { label: 'Thành công', color: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20' },
    error: { label: 'Lỗi', color: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/20' },
    timeout: { label: 'Quá hạn', color: 'bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-500/20' },
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
    // TRANSLATE_DUB pipeline
    'dub.ingest': { label: 'Tách âm thanh & chuẩn hoá', icon: 'FileAudio' },
    'dub.ocr': { label: 'Nhận dạng phụ đề (OCR)', icon: 'ScanText' },
    'dub.stt': { label: 'Nhận dạng giọng nói', icon: 'Mic' },
    'dub.translate': { label: 'Dịch theo phong cách', icon: 'Languages' },
    'dub.ttsAlign': { label: 'Lồng tiếng & khớp thời gian', icon: 'AudioLines' },
    'dub.render': { label: 'Che chữ & xuất video', icon: 'Video' },
  };

  export const STAGE_ORDER = [
    ...['summary.transcribe', 'summary.sceneDetect', 'summary.analyze', 'summary.script', 'summary.align', 'summary.tts', 'summary.subtitle', 'summary.render'],
    ...['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'],
  ];

  export const MODE_LABELS = {
    SUMMARY: 'Review phim',
    TRANSLATE_DUB: 'Dịch & Lồng tiếng',
    // bản lowercase do backend MVP lưu
    summary: 'Review phim',
    translate_dub: 'Dịch & Lồng tiếng',
  };

  export const DUB_STAGES = ['dub.ingest', 'dub.ocr', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render'];



  export const SOURCE_LANGUAGES = {
    auto: 'Tự động nhận diện',
    en: 'Tiếng Anh',
    ja: 'Tiếng Nhật',
    ko: 'Tiếng Hàn',
    zh: 'Tiếng Trung',
  };

  export const TARGET_LANGUAGES = {
    vi: 'Tiếng Việt',
    en: 'Tiếng Anh',
  };

  // Fallback khi GET /style-presets chưa sẵn sàng ở backend — khớp seed 12 StylePreset (docs/05)
  export const STYLE_PRESETS_FALLBACK = [
    { slug: 'co-trang', name: 'Cổ trang', description: 'Cổ phong, xưng hô "bổn tọa", "hiền muội"' },
    { slug: 'bat-trend', name: 'Bắt trend', description: 'Gen Z, slang mạng, lối nói viral' },
    { slug: 'review-phim', name: 'Review phim', description: 'Phân tích, châm biếm nhẹ' },
    { slug: 'tinh-cam', name: 'Tình cảm / học đường', description: 'Mềm mại, xưng "anh/em"' },
    { slug: 'tai-lieu', name: 'Tài liệu / chính biên', description: 'Chuẩn mực, trung tính' },
    { slug: 'hai-huoc', name: 'Hài hước / meme', description: 'Chơi chữ, twist bất ngờ' },
    { slug: 'chinh-luan', name: 'Tin tức / chính luận', description: 'Trang trọng, khách quan' },
    { slug: 'gaming', name: 'Gaming / esports', description: 'Thuật ngữ game, năng lượng cao' },
    { slug: 'kinh-di', name: 'Kinh dị / rùng rợn', description: 'Giọng kể căng, rùng rợn' },
    { slug: 'the-thao', name: 'Thể thao', description: 'Sôi động, cảm thán' },
    { slug: 'cong-nghe', name: 'Công nghệ', description: 'Chính xác thuật ngữ kỹ thuật' },
    { slug: 'tre-em', name: 'Thiếu nhi / gia đình', description: 'Đơn giản, dễ hiểu' },
    { slug: 'sat-nghia', name: 'Sát nghĩa (Nguyên gốc)', description: 'Dịch sát nguyên gốc, giữ nguyên cấu trúc' },
  ];

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
    edge_tts: 'Edge TTS (Miễn phí)',
    elevenlabs: 'ElevenLabs',
    google_tts: 'Google TTS',
    azure_speech: 'Azure Speech',
    openai_tts: 'OpenAI TTS',
  };
  
  export const LLM_PROVIDERS = ['gemini', 'openai', 'anthropic', 'huggingface'];
  export const IMAGE_PROVIDERS = ['flux', 'stable_diffusion', 'google_image', 'huggingface_inference'];
  export const VIDEO_PROVIDERS = ['kling', 'hailuo', 'pixverse', 'runway', 'luma'];
  export const VOICE_PROVIDERS = ['edge_tts', 'elevenlabs', 'google_tts', 'azure_speech', 'openai_tts'];
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