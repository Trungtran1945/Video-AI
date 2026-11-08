import React from 'react';
import { Sliders, Clock, Volume2, Type, Trash2 } from 'lucide-react';
import { useTimelineStore } from '../timeline/timelineStore';

export default function ClipInspector({ selectedClip, onUpdateClip, onDeleteClip }) {
  const { deleteClip } = useTimelineStore();

  if (!selectedClip) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center text-muted-foreground select-none bg-card border-l border-border">
        <Sliders className="w-10 h-10 stroke-1 mb-2.5 opacity-40" />
        <span className="text-xs font-semibold text-foreground">Chưa chọn Clip nào</span>
        <p className="text-[11px] opacity-75 mt-1 max-w-[200px]">
          Nhấp vào bất kỳ clip nào trên Timeline để xem và chỉnh sửa thông số.
        </p>
      </div>
    );
  }

  const clipType = selectedClip.clip_type || selectedClip.type || 'image';
  const isTextClip = clipType === 'text';
  const isAudioClip = clipType === 'voiceover' || clipType === 'music' || clipType === 'sfx';

  // Parse style_json if available
  let textStyle = { fontSize: 28, color: '#FFFFFF', bg: 'rgba(0,0,0,0.6)', position: 'bottom' };
  try {
    if (typeof selectedClip.style_json === 'string') {
      textStyle = { ...textStyle, ...JSON.parse(selectedClip.style_json) };
    } else if (selectedClip.style && typeof selectedClip.style === 'object') {
      textStyle = { ...textStyle, ...selectedClip.style };
    }
  } catch (_) {}

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

  const handleDelete = () => {
    deleteClip(selectedClip.id);
    onDeleteClip?.(selectedClip.id);
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
          {clipType}
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
                value={Number(selectedClip.start ?? selectedClip.start_at_sec ?? 0).toFixed(2)}
                onChange={(e) =>
                  onUpdateClip?.(selectedClip.id, {
                    start: Math.max(0, parseFloat(e.target.value) || 0),
                    start_at_sec: Math.max(0, parseFloat(e.target.value) || 0),
                  })
                }
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] text-muted-foreground mb-1 block">Thời lượng (s):</label>
              <input
                type="number"
                step="0.1"
                min="0.2"
                value={Number(selectedClip.duration ?? selectedClip.out_sec ?? 4).toFixed(2)}
                onChange={(e) =>
                  onUpdateClip?.(selectedClip.id, {
                    duration: Math.max(0.2, parseFloat(e.target.value) || 0.2),
                    out_sec: Math.max(0.2, parseFloat(e.target.value) || 0.2),
                  })
                }
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono focus:outline-none"
              />
            </div>
          </div>
        </div>

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
              className="w-full accent-primary"
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
                className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground focus:outline-none"
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
                  min="16"
                  max="72"
                  value={textStyle.fontSize || 28}
                  onChange={(e) => handleStyleChange('fontSize', parseInt(e.target.value, 10) || 28)}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-mono"
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
                    className={`py-1 text-xs rounded-md border capitalize font-medium transition ${
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
                  className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition ${
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
                  className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition ${
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
                  className={`px-2.5 py-1 text-xs rounded-lg border font-medium transition ${
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
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-semibold transition"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Xóa Clip khỏi Timeline</span>
        </button>
      </div>
    </div>
  );
}
