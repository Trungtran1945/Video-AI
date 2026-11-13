import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Clock,
  Volume2,
  Type,
  Trash2,
  Layers,
  RotateCcw,
  Check,
  Video,
  Image as ImageIcon,
  ScanText,
  FileAudio,
} from 'lucide-react';
import { useTimelineStore } from '../timeline/timelineStore';

export default function ClipInspector({
  selectedClip,
  assets = [],
  onUpdateClip,
  onDeleteClip,
  onSetBackground,
  onOpenOcr,
}) {
  const { deleteClip } = useTimelineStore();

  const [startInput, setStartInput] = useState('');
  const [durationInput, setDurationInput] = useState('');

  // Sync inputs when clip selection or timing changes externally
  useEffect(() => {
    if (selectedClip) {
      const s = Number(selectedClip.start ?? selectedClip.start_at_sec ?? 0);
      const d = Number(selectedClip.duration ?? selectedClip.out_sec ?? 4);
      setStartInput(String(Number(s.toFixed(2))));
      setDurationInput(String(Number(d.toFixed(2))));
    }
  }, [selectedClip?.id, selectedClip?.start, selectedClip?.duration]);

  if (!selectedClip) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none bg-card border-l border-border">
        <Sliders className="w-10 h-10 stroke-1 mb-2.5 opacity-40 text-primary" />
        <span className="text-xs font-semibold text-foreground">Chưa chọn Clip nào</span>
        <p className="text-[11px] opacity-75 mt-1 max-w-[200px]">
          Nhấp vào bất kỳ clip nào trên Timeline để xem và tùy chỉnh thông số chi tiết.
        </p>
      </div>
    );
  }

  const clipType = selectedClip.clip_type || selectedClip.type || 'image';
  const isBgClip = clipType === 'background';
  const isTextClip = clipType === 'text';
  const isAudioClip = clipType === 'voiceover' || clipType === 'music' || clipType === 'sfx';
  const isVisualClip = clipType === 'image' || clipType === 'video';
  const isVideoClip = clipType === 'video';

  const meta = selectedClip.meta || {};
  const currentAsset = (assets || []).find(
    (a) => a.id === (selectedClip.asset_id || selectedClip.assetId || selectedClip.audio_id || selectedClip.voice_audio_id)
  );

  const isVideoBg = Boolean(
    meta.isVideo ||
    currentAsset?.kind === 'video' ||
    currentAsset?.mimeType?.startsWith('video/') ||
    currentAsset?.mime_type?.startsWith('video/') ||
    /\.(mp4|webm|mov|mkv)$/i.test(currentAsset?.storageKey || currentAsset?.storage_key || '')
  );

  // Parse style_json if available
  let textStyle = { fontSize: 28, color: '#FFFFFF', bg: 'rgba(0,0,0,0.65)', position: 'bottom', fontFamily: 'Arial' };
  try {
    if (typeof selectedClip.style_json === 'string') {
      textStyle = { ...textStyle, ...JSON.parse(selectedClip.style_json) };
    } else if (selectedClip.style && typeof selectedClip.style === 'object') {
      textStyle = { ...textStyle, ...selectedClip.style };
    }
  } catch (_) {}

  const handleStartChange = (val) => {
    setStartInput(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0) {
      onUpdateClip?.(selectedClip.id, {
        start: num,
        start_at_sec: num,
      });
    }
  };

  const handleStartBlur = () => {
    const num = Math.max(0, parseFloat(startInput) || 0);
    setStartInput(String(Number(num.toFixed(2))));
    onUpdateClip?.(selectedClip.id, {
      start: num,
      start_at_sec: num,
    });
  };

  const handleDurationChange = (val) => {
    setDurationInput(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0.1) {
      onUpdateClip?.(selectedClip.id, {
        duration: num,
        out_sec: num,
      });
    }
  };

  const handleDurationBlur = () => {
    const num = Math.max(0.1, parseFloat(durationInput) || 0.1);
    setDurationInput(String(Number(num.toFixed(2))));
    onUpdateClip?.(selectedClip.id, {
      duration: num,
      out_sec: num,
    });
  };

  const handleTextChange = (val) => {
    onUpdateClip?.(selectedClip.id, {
      textContent: val,
      text_content: val,
      content: val,
    });
  };

  const handleStyleChange = (key, val) => {
    const updated = { ...textStyle, [key]: val };
    onUpdateClip?.(selectedClip.id, {
      style_json: JSON.stringify(updated),
      style: updated,
    });
  };

  const handleMetaChange = (key, val) => {
    const updatedMeta = { ...meta, [key]: val };
    onUpdateClip?.(selectedClip.id, {
      meta: updatedMeta,
    });
  };

  const handleRemoveBgAsset = () => {
    onUpdateClip?.(selectedClip.id, {
      assetId: null,
      asset_id: null,
      meta: { ...meta, isVideo: false, name: null },
    });
  };

  const handleDelete = () => {
    if (onDeleteClip) {
      onDeleteClip(selectedClip.id);
    } else {
      deleteClip(selectedClip.id);
    }
  };

  return (
    <div className="h-full flex flex-col bg-card border-l border-border select-none text-left overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-border flex items-center justify-between bg-muted/30">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-primary" />
          <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Thuộc tính Clip
          </h4>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase font-bold">
          {isBgClip ? 'NỀN (BACKGROUND)' : clipType}
        </span>
      </div>

      <div className="p-4 space-y-4 flex-1">
        {/* Timing Controls */}
        <div className="p-3 rounded-xl bg-muted/30 border border-border space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Clock className="w-3.5 h-3.5 text-primary" />
            <span>Thời gian & Vị trí</span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Bắt đầu (s):</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={startInput}
                onChange={(e) => handleStartChange(e.target.value)}
                onBlur={handleStartBlur}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>

            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Thời lượng (s):</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                value={durationInput}
                onChange={(e) => handleDurationChange(e.target.value)}
                onBlur={handleDurationBlur}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
          </div>
        </div>

        {/* Visual Clip Controls (Image or Video) */}
        {isVisualClip && (
          <div className="p-3 rounded-xl bg-muted/30 border border-border space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                {isVideoClip ? <Video className="w-3.5 h-3.5 text-blue-500" /> : <ImageIcon className="w-3.5 h-3.5 text-emerald-500" />}
                <span>{isVideoClip ? 'Cấu hình Video' : 'Cấu hình Hình ảnh'}</span>
              </div>
              {currentAsset && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  {currentAsset.durationSec ? `${Number(currentAsset.durationSec).toFixed(1)}s` : ''}
                </span>
              )}
            </div>

            {/* Media Information Card */}
            {currentAsset && (
              <div className="flex items-center gap-2.5 p-2 rounded-lg bg-background/80 border border-border/80">
                {currentAsset.thumbnailUrl || (currentAsset.kind === 'image' && currentAsset.url) ? (
                  <img
                    src={currentAsset.thumbnailUrl || currentAsset.url}
                    alt={currentAsset.name}
                    className="w-10 h-10 rounded object-cover border border-border bg-black/20 shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center shrink-0 text-primary">
                    {isVideoClip ? <Video className="w-5 h-5" /> : <ImageIcon className="w-5 h-5" />}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-semibold text-foreground truncate block">
                    {currentAsset.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    ID: {currentAsset.id.slice(0, 8)}...
                  </span>
                </div>
              </div>
            )}

            {/* Fit Mode */}
            <div>
              <label className="text-[11px] text-muted-foreground mb-1.5 block">Chế độ hiển thị (Fit Mode):</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleMetaChange('fit', 'contain')}
                  className={`py-1.5 px-2 text-xs rounded-lg border font-medium transition flex items-center justify-center gap-1 cursor-pointer ${
                    (meta.fit || 'contain') === 'contain'
                      ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {(meta.fit || 'contain') === 'contain' && <Check className="w-3 h-3" />}
                  <span>Vừa khung (Contain)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleMetaChange('fit', 'cover')}
                  className={`py-1.5 px-2 text-xs rounded-lg border font-medium transition flex items-center justify-center gap-1 cursor-pointer ${
                    meta.fit === 'cover'
                      ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {meta.fit === 'cover' && <Check className="w-3 h-3" />}
                  <span>Lấp đầy (Cover)</span>
                </button>
              </div>
            </div>

            {/* Opacity Slider */}
            <div className="space-y-1.5 pt-1 border-t border-border/60">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">Độ mờ đục (Opacity):</span>
                <span className="text-xs font-mono font-medium text-foreground">
                  {Math.round((meta.opacity != null ? Number(meta.opacity) : 1.0) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={Math.round((meta.opacity != null ? Number(meta.opacity) : 1.0) * 100)}
                onChange={(e) => handleMetaChange('opacity', Number(e.target.value) / 100)}
                className="w-full accent-primary cursor-pointer"
              />
            </div>

            {/* Video-specific volume slider */}
            {isVideoClip && (
              <div className="space-y-1.5 pt-1 border-t border-border/60">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">Âm lượng Video:</span>
                  <span className="text-xs font-mono font-medium text-foreground">
                    {Math.round((Number(selectedClip.volume) || 1.0) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={Number(selectedClip.volume ?? 1.0)}
                  onChange={(e) =>
                    onUpdateClip?.(selectedClip.id, {
                      volume: parseFloat(e.target.value),
                    })
                  }
                  className="w-full accent-primary cursor-pointer"
                />
              </div>
            )}

            {/* Quick Action: OCR if image */}
            {clipType === 'image' && currentAsset && onOpenOcr && (
              <div className="pt-1 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => onOpenOcr(currentAsset)}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-background hover:bg-muted text-foreground text-xs font-medium transition cursor-pointer"
                >
                  <ScanText className="w-3.5 h-3.5 text-primary" />
                  <span>Quét & Dịch chữ trên ảnh</span>
                </button>
              </div>
            )}

            {/* Quick Action: Set as background */}
            {currentAsset && onSetBackground && (
              <div className="pt-1 border-t border-border/60">
                <button
                  type="button"
                  onClick={() => onSetBackground(currentAsset)}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 text-purple-600 dark:text-purple-400 text-xs font-medium transition cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Đặt clip này làm nền dự án</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Background Settings Controls */}
        {isBgClip && (
          <div className="p-3 rounded-xl bg-muted/30 border border-border space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Layers className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                <span>Cấu hình Lớp nền</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-700 dark:text-purple-400 border border-purple-500/20 font-bold uppercase">
                {isVideoBg ? 'Video Nền' : currentAsset ? 'Ảnh Nền' : 'Nền màu'}
              </span>
            </div>

            {/* Media Information */}
            <div className="p-2.5 rounded-lg bg-background/80 border border-border/80 space-y-1">
              <span className="text-[11px] font-semibold text-foreground truncate block">
                {currentAsset?.name || meta.name || 'Nền mặc định (#0F1117)'}
              </span>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
                <span>{isVideoBg ? 'Định dạng Video' : currentAsset ? 'Định dạng Hình ảnh' : 'Màu thuần'}</span>
                {currentAsset?.durationSec && <span>{Number(currentAsset.durationSec).toFixed(1)}s gốc</span>}
              </div>
            </div>

            {/* Fit Mode Selection */}
            <div>
              <label className="text-[11px] text-muted-foreground mb-1.5 block">Chế độ hiển thị (Fit Mode):</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleMetaChange('fit', 'cover')}
                  className={`py-1.5 px-2 text-xs rounded-lg border font-medium transition flex items-center justify-center gap-1 cursor-pointer ${
                    (meta.fit || 'cover') === 'cover'
                      ? 'bg-purple-600 text-white border-purple-500 shadow-xs'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {(meta.fit || 'cover') === 'cover' && <Check className="w-3 h-3" />}
                  <span>Cover (Lấp đầy)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleMetaChange('fit', 'contain')}
                  className={`py-1.5 px-2 text-xs rounded-lg border font-medium transition flex items-center justify-center gap-1 cursor-pointer ${
                    meta.fit === 'contain'
                      ? 'bg-purple-600 text-white border-purple-500 shadow-xs'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {meta.fit === 'contain' && <Check className="w-3 h-3" />}
                  <span>Contain (Vừa khung)</span>
                </button>
              </div>
            </div>

            {/* Video-specific Toggles */}
            {isVideoBg && (
              <div className="space-y-2 pt-1 border-t border-border/60">
                <label className="flex items-center justify-between text-xs text-foreground cursor-pointer select-none">
                  <span className="text-[11px] text-muted-foreground">Lặp lại video (Loop):</span>
                  <input
                    type="checkbox"
                    checked={meta.loop !== false}
                    onChange={(e) => handleMetaChange('loop', e.target.checked)}
                    className="w-4 h-4 rounded border-border text-purple-600 focus:ring-purple-500 cursor-pointer accent-purple-600"
                  />
                </label>
                <label className="flex items-center justify-between text-xs text-foreground cursor-pointer select-none">
                  <span className="text-[11px] text-muted-foreground">Tắt tiếng video (Muted):</span>
                  <input
                    type="checkbox"
                    checked={meta.muted !== false}
                    onChange={(e) => handleMetaChange('muted', e.target.checked)}
                    className="w-4 h-4 rounded border-border text-purple-600 focus:ring-purple-500 cursor-pointer accent-purple-600"
                  />
                </label>
              </div>
            )}

            {/* Opacity Slider */}
            <div className="space-y-1.5 pt-1 border-t border-border/60">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">Độ mờ lớp nền (Opacity):</span>
                <span className="text-xs font-mono font-medium text-foreground">
                  {Math.round((meta.opacity != null ? Number(meta.opacity) : 0.7) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="20"
                max="100"
                step="5"
                value={Math.round((meta.opacity != null ? Number(meta.opacity) : 0.7) * 100)}
                onChange={(e) => handleMetaChange('opacity', Number(e.target.value) / 100)}
                className="w-full accent-purple-600 cursor-pointer"
              />
            </div>

            {/* Remove / Reset Background Button */}
            {currentAsset && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleRemoveBgAsset}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-medium transition cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Gỡ bỏ tệp nền (Về màu tối)</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Audio Volume Controls (for audio tracks) */}
        {isAudioClip && (
          <div className="p-3 rounded-xl bg-muted/30 border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Volume2 className="w-3.5 h-3.5 text-primary" />
                <span>Âm lượng Clip</span>
              </div>
              <span className="text-xs font-mono font-medium text-foreground">
                {Math.round((Number(selectedClip.volume) || 1) * 100)}%
              </span>
            </div>

            {currentAsset && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-background/80 border border-border/80">
                <FileAudio className="w-4 h-4 text-primary shrink-0" />
                <span className="text-[11px] font-semibold text-foreground truncate block flex-1">
                  {currentAsset.name || selectedClip.content || 'Âm thanh'}
                </span>
                {currentAsset.durationSec && (
                  <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                    {Number(currentAsset.durationSec).toFixed(1)}s
                  </span>
                )}
              </div>
            )}

            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={Number(selectedClip.volume ?? 1)}
              onChange={(e) =>
                onUpdateClip?.(selectedClip.id, {
                  volume: parseFloat(e.target.value),
                })
              }
              className="w-full accent-primary cursor-pointer"
            />
          </div>
        )}

        {/* Text Overlay Style Controls */}
        {isTextClip && (
          <div className="p-3 rounded-xl bg-muted/30 border border-border space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Type className="w-3.5 h-3.5 text-primary" />
              <span>Nội dung & Kiểu chữ</span>
            </div>

            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Văn bản hiển thị:</label>
              <textarea
                value={selectedClip.textContent || selectedClip.text_content || selectedClip.content || ''}
                onChange={(e) => handleTextChange(e.target.value)}
                rows={3}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 leading-relaxed"
              />
            </div>

            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Phông chữ:</label>
              <select
                value={textStyle.fontFamily || 'Arial'}
                onChange={(e) => handleStyleChange('fontFamily', e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground focus:outline-none"
              >
                <option value="Arial">Arial (Mặc định)</option>
                <option value="Roboto">Roboto</option>
                <option value="Montserrat">Montserrat</option>
                <option value="Times New Roman">Times New Roman</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] text-muted-foreground mb-1 block">Cỡ chữ (px):</label>
                <input
                  type="number"
                  min="14"
                  max="72"
                  value={textStyle.fontSize || 28}
                  onChange={(e) => handleStyleChange('fontSize', parseInt(e.target.value, 10) || 28)}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[11px] text-muted-foreground mb-1 block">Màu chữ:</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={textStyle.color || '#FFFFFF'}
                    onChange={(e) => handleStyleChange('color', e.target.value)}
                    className="w-7 h-7 rounded border border-border cursor-pointer bg-transparent"
                  />
                  <span className="text-xs font-mono text-muted-foreground">{textStyle.color}</span>
                </div>
              </div>
            </div>

            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Vị trí:</label>
              <div className="grid grid-cols-3 gap-1.5">
                {['top', 'center', 'bottom'].map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => handleStyleChange('position', pos)}
                    className={`py-1 text-xs rounded-md border capitalize font-medium transition cursor-pointer ${
                      textStyle.position === pos
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted text-muted-foreground border-border'
                    }`}
                  >
                    {pos === 'top' ? 'Trên' : pos === 'center' ? 'Giữa' : 'Dưới'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Nền văn bản:</label>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => handleStyleChange('bg', 'rgba(0,0,0,0.65)')}
                  className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition cursor-pointer ${
                    textStyle.bg === 'rgba(0,0,0,0.65)' || !textStyle.bg
                      ? 'bg-primary/20 text-primary border-primary/40'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  Đen mờ
                </button>
                <button
                  type="button"
                  onClick={() => handleStyleChange('bg', 'transparent')}
                  className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition cursor-pointer ${
                    textStyle.bg === 'transparent'
                      ? 'bg-primary/20 text-primary border-primary/40'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  Trong suốt
                </button>
                <button
                  type="button"
                  onClick={() => handleStyleChange('bg', '#000000')}
                  className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition cursor-pointer ${
                    textStyle.bg === '#000000'
                      ? 'bg-primary/20 text-primary border-primary/40'
                      : 'bg-background hover:bg-muted text-muted-foreground border-border'
                  }`}
                >
                  Đen đậm
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete Clip Footer */}
      <div className="p-3 border-t border-border bg-muted/20">
        <button
          type="button"
          onClick={handleDelete}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-semibold transition cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Xóa Clip khỏi Timeline</span>
        </button>
      </div>
    </div>
  );
}
