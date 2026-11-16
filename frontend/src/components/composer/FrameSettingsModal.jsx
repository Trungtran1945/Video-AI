import React, { useState, useEffect } from 'react';
import {
  X,
  Check,
  Settings2,
  Maximize2,
  Film,
  Palette,
  Lock,
  Unlock,
  Loader2,
  Tv,
  Smartphone,
  Square,
  Sparkles,
} from 'lucide-react';

export const RATIO_PRESETS = [
  { id: '16:9', label: '16:9', desc: 'YouTube, Ngang', icon: Tv, defaultRes: { '1080p': [1920, 1080], '720p': [1280, 720], '4k': [3840, 2160] } },
  { id: '9:16', label: '9:16', desc: 'TikTok, Reels, Shorts', icon: Smartphone, defaultRes: { '1080p': [1080, 1920], '720p': [720, 1280], '4k': [2160, 3840] } },
  { id: '1:1', label: '1:1', desc: 'Instagram Square', icon: Square, defaultRes: { '1080p': [1080, 1080], '720p': [720, 720], '4k': [2160, 2160] } },
  { id: '4:3', label: '4:3', desc: 'Truyền hình Classic', icon: Tv, defaultRes: { '1080p': [1440, 1080], '720p': [960, 720], '4k': [2880, 2160] } },
  { id: '3:4', label: '3:4', desc: 'Khung ảnh dọc', icon: Smartphone, defaultRes: { '1080p': [1080, 1440], '720p': [720, 960], '4k': [2160, 2880] } },
  { id: '4:5', label: '4:5', desc: 'Instagram Portrait', icon: Smartphone, defaultRes: { '1080p': [1080, 1350], '720p': [720, 900], '4k': [2160, 2700] } },
  { id: '21:9', label: '21:9', desc: 'Cinematic Ultrawide', icon: Film, defaultRes: { '1080p': [2560, 1080], '720p': [1706, 720], '4k': [3840, 1646] } },
  { id: 'custom', label: 'Tùy chỉnh', desc: 'W x H tự chọn', icon: Settings2, defaultRes: { '1080p': [1920, 1080], '720p': [1280, 720], '4k': [3840, 2160] } },
];

const RESOLUTION_OPTIONS = [
  { id: '720p', label: '720p (HD)' },
  { id: '1080p', label: '1080p (FHD - Chuẩn)' },
  { id: '4k', label: '4K (Ultra HD)' },
];

const FPS_OPTIONS = [24, 30, 60];

const COLOR_PRESETS = [
  { color: '#0F1117', label: 'Obsidian' },
  { color: '#000000', label: 'Đen sâu' },
  { color: '#18181B', label: 'Xám than' },
  { color: '#1E1E2E', label: 'Slate' },
  { color: '#0F172A', label: 'Midnight' },
  { color: '#052E16', label: 'Forest' },
  { color: '#FFFFFF', label: 'Trắng' },
];

export function toEven(num) {
  const n = Math.max(2, Math.round(Number(num) || 2));
  return n - (n % 2);
}

export default function FrameSettingsModal({
  isOpen,
  onClose,
  project,
  onSave,
}) {
  const params = project?.params || {};
  const currentRatio = project?.aspect_ratio || project?.aspectRatio || params.aspectRatio || '16:9';
  const currentRes = params.resolution || '1080p';
  const currentFps = Number(params.fps) || 30;
  const currentBg = params.defaultBackground || '#0F1117';

  const [selectedRatio, setSelectedRatio] = useState(currentRatio);
  const [resolution, setResolution] = useState(currentRes);
  const [fps, setFps] = useState(currentFps);
  const [defaultBackground, setDefaultBackground] = useState(currentBg);

  const [customWidth, setCustomWidth] = useState(params.width || 1920);
  const [customHeight, setCustomHeight] = useState(params.height || 1080);
  const [lockRatio, setLockRatio] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Sync state whenever modal opens or project changes
  useEffect(() => {
    if (isOpen) {
      const r = project?.aspect_ratio || project?.aspectRatio || params.aspectRatio || '16:9';
      setSelectedRatio(r);
      setResolution(params.resolution || '1080p');
      setFps(Number(params.fps) || 30);
      setDefaultBackground(params.defaultBackground || '#0F1117');

      if (params.width && params.height) {
        setCustomWidth(toEven(params.width));
        setCustomHeight(toEven(params.height));
      } else {
        const preset = RATIO_PRESETS.find((p) => p.id === r) || RATIO_PRESETS[0];
        const [w, h] = preset.defaultRes[params.resolution || '1080p'] || [1920, 1080];
        setCustomWidth(w);
        setCustomHeight(h);
      }
      setError(null);
    }
  }, [isOpen, project]);

  if (!isOpen) return null;

  const handleRatioSelect = (ratioId) => {
    setSelectedRatio(ratioId);
    if (ratioId !== 'custom') {
      const preset = RATIO_PRESETS.find((p) => p.id === ratioId);
      if (preset && preset.defaultRes[resolution]) {
        const [w, h] = preset.defaultRes[resolution];
        setCustomWidth(w);
        setCustomHeight(h);
      }
    }
  };

  const handleResolutionSelect = (resId) => {
    setResolution(resId);
    if (selectedRatio !== 'custom') {
      const preset = RATIO_PRESETS.find((p) => p.id === selectedRatio);
      if (preset && preset.defaultRes[resId]) {
        const [w, h] = preset.defaultRes[resId];
        setCustomWidth(w);
        setCustomHeight(h);
      }
    }
  };

  const handleWidthChange = (val) => {
    const raw = parseInt(val, 10) || 0;
    const w = Math.min(4096, Math.max(128, raw));
    const evenW = toEven(w);
    setCustomWidth(evenW);
    if (lockRatio && customWidth > 0) {
      const ratio = customHeight / customWidth;
      setCustomHeight(toEven(Math.round(evenW * ratio)));
    }
    setSelectedRatio('custom');
  };

  const handleHeightChange = (val) => {
    const raw = parseInt(val, 10) || 0;
    const h = Math.min(4096, Math.max(128, raw));
    const evenH = toEven(h);
    setCustomHeight(evenH);
    if (lockRatio && customHeight > 0) {
      const ratio = customWidth / customHeight;
      setCustomWidth(toEven(Math.round(evenH * ratio)));
    }
    setSelectedRatio('custom');
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const finalW = toEven(customWidth);
      const finalH = toEven(customHeight);

      const payload = {
        aspectRatio: selectedRatio,
        params: {
          ...params,
          aspectRatio: selectedRatio,
          resolution,
          fps,
          width: finalW,
          height: finalH,
          defaultBackground,
        },
      };

      await onSave?.(payload);
      onClose();
    } catch (err) {
      console.error('Save frame settings error:', err);
      setError(err?.response?.data?.message || err.message || 'Lỗi lưu cấu hình khung hình');
    } finally {
      setSaving(false);
    }
  };

  // Compute live visual aspect ratio for preview box
  const previewRatio = customWidth > 0 && customHeight > 0 ? `${customWidth}/${customHeight}` : '16/9';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs select-none animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between bg-muted/30">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center border border-primary/20">
              <Settings2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">Cấu hình Khung hình & Độ phân giải</h3>
              <p className="text-[11px] text-muted-foreground">Tùy chỉnh tỉ lệ khung hình (Aspect Ratio), độ phân giải và phông nền</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1 text-left">
          {error && (
            <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center justify-between">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} className="text-destructive font-bold ml-2">×</button>
            </div>
          )}

          {/* 1. Aspect Ratio Presets */}
          <div>
            <label className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
              <Maximize2 className="w-3.5 h-3.5 text-primary" />
              <span>Tỉ lệ khung hình (Aspect Ratio):</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {RATIO_PRESETS.map((preset) => {
                const Icon = preset.icon;
                const isSelected = selectedRatio === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleRatioSelect(preset.id)}
                    className={`p-2.5 rounded-xl border text-left transition flex flex-col justify-between cursor-pointer ${
                      isSelected
                        ? 'bg-primary/10 border-primary text-foreground shadow-xs ring-1 ring-primary/40'
                        : 'bg-background hover:bg-muted/60 border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-bold font-mono">{preset.label}</span>
                      <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-primary' : 'opacity-40'}`} />
                    </div>
                    <span className="text-[10px] opacity-75 truncate">{preset.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Resolution & Custom Dimensions */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl bg-muted/20 border border-border">
            {/* Resolution Selector */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Độ phân giải chuẩn:</label>
              <div className="grid grid-cols-3 gap-1.5">
                {RESOLUTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleResolutionSelect(opt.id)}
                    className={`py-1.5 px-2 text-[11px] font-semibold rounded-lg border transition cursor-pointer text-center ${
                      resolution === opt.id
                        ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                        : 'bg-background hover:bg-muted text-muted-foreground border-border'
                    }`}
                  >
                    {opt.id.toUpperCase()}
                  </button>
                ))}
              </div>

              {/* FPS Selector */}
              <div className="mt-3">
                <label className="text-xs font-semibold text-foreground mb-1.5 block">Tốc độ khung hình (FPS):</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {FPS_OPTIONS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFps(f)}
                      className={`py-1.5 px-2 text-[11px] font-semibold rounded-lg border transition cursor-pointer text-center ${
                        fps === f
                          ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                          : 'bg-background hover:bg-muted text-muted-foreground border-border'
                      }`}
                    >
                      {f} fps
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Custom Pixel Dimensions */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-foreground">Kích thước pixel (W x H):</label>
                <button
                  type="button"
                  onClick={() => setLockRatio(!lockRatio)}
                  title={lockRatio ? 'Đang khóa tỉ lệ' : 'Đang mở khóa tỉ lệ'}
                  className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded cursor-pointer transition ${
                    lockRatio ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {lockRatio ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                  <span>{lockRatio ? 'Khóa tỉ lệ' : 'Tự do'}</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[10px] text-muted-foreground block mb-0.5">Chiều rộng (W):</span>
                  <input
                    type="number"
                    min="128"
                    max="4096"
                    step="2"
                    value={customWidth}
                    onChange={(e) => handleWidthChange(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground block mb-0.5">Chiều cao (H):</span>
                  <input
                    type="number"
                    min="128"
                    max="4096"
                    step="2"
                    value={customHeight}
                    onChange={(e) => handleHeightChange(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
                  />
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground mt-1.5">
                * Kích thước được tự động làm tròn số chẵn cho chuẩn H.264 / MP4.
              </p>
            </div>
          </div>

          {/* 3. Live Preview & Background Color */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Color Picker & Swatches */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-primary" />
                <span>Màu nền mặc định (Canvas Background):</span>
              </label>

              <div className="flex items-center gap-2 mb-2.5">
                <input
                  type="color"
                  value={defaultBackground}
                  onChange={(e) => setDefaultBackground(e.target.value)}
                  className="w-8 h-8 rounded-lg border border-border cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={defaultBackground}
                  onChange={(e) => setDefaultBackground(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono uppercase"
                  placeholder="#0F1117"
                />
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {COLOR_PRESETS.map((swatch) => (
                  <button
                    key={swatch.color}
                    type="button"
                    onClick={() => setDefaultBackground(swatch.color)}
                    style={{ backgroundColor: swatch.color }}
                    title={swatch.label}
                    className={`w-6 h-6 rounded-md border transition cursor-pointer relative flex items-center justify-center ${
                      defaultBackground.toLowerCase() === swatch.color.toLowerCase()
                        ? 'ring-2 ring-primary ring-offset-2 ring-offset-card border-primary'
                        : 'border-border/60 hover:scale-110'
                    }`}
                  >
                    {defaultBackground.toLowerCase() === swatch.color.toLowerCase() && (
                      <Check className={`w-3.5 h-3.5 ${swatch.color === '#FFFFFF' ? 'text-black' : 'text-white'}`} />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Live Frame Shape Preview */}
            <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-muted/30 border border-border">
              <span className="text-[10px] text-muted-foreground mb-2">Xem thử tỉ lệ khung:</span>
              <div
                style={{
                  aspectRatio: previewRatio,
                  backgroundColor: defaultBackground,
                }}
                className="w-36 max-h-24 rounded-lg border border-primary/40 shadow-inner flex items-center justify-center relative overflow-hidden transition-all duration-300"
              >
                <div className="flex flex-col items-center justify-center text-center p-1 pointer-events-none">
                  <span className={`text-[10px] font-mono font-bold ${defaultBackground === '#FFFFFF' ? 'text-black' : 'text-white'}`}>
                    {customWidth} × {customHeight}
                  </span>
                  <span className={`text-[9px] opacity-75 font-mono ${defaultBackground === '#FFFFFF' ? 'text-black' : 'text-white'}`}>
                    {selectedRatio}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2.5 bg-muted/30">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-semibold text-foreground transition cursor-pointer"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition flex items-center gap-1.5 shadow-sm cursor-pointer disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>Áp dụng cấu hình</span>
          </button>
        </div>
      </div>
    </div>
  );
}
