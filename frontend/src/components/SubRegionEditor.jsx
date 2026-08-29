import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, ScanText } from 'lucide-react';

let tmpSeq = 0;

/**
 * SubRegionEditor v1 — chỉnh vùng che hardsub trên khung hình video tạm dừng.
 * - Kéo để di chuyển vùng, kéo góc phải-dưới để resize
 * - Thêm/xoá region, sửa khoảng thời gian hiển thị
 * - Toạ độ lưu theo pixel của video gốc (khớp model OcrRegion)
 */
export default function SubRegionEditor({ videoUrl, regions = [], onChange, onSave, saving, saveError }) {
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const [videoSize, setVideoSize] = useState(null); // { w, h } intrinsic
  const [selectedId, setSelectedId] = useState(null);
  const drag = useRef(null);

  const selected = regions.find((r) => r.id === selectedId) || null;

  // Luôn gắn listener trên window; chỉ xử lý khi đang kéo (drag.current != null).
  // (Trước đây effect early-return nếu drag.current rỗng — mà ref thay đổi không
  // trigger re-render nên listener không bao giờ được gắn → không kéo/thả được.)
  useEffect(() => {
    const onMove = (e) => {
      const d = drag.current;
      if (!d) return;
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box || !videoSize) return;
      const scaleX = videoSize.w / box.width;
      const scaleY = videoSize.h / box.height;
      const dx = (e.clientX - d.startX) * scaleX;
      const dy = (e.clientY - d.startY) * scaleY;
      onChange(
        regions.map((r) => {
          if (r.id !== d.id) return r;
          if (d.mode === 'move') {
            return {
              ...r,
              x: clamp(Math.round(d.orig.x + dx), 0, videoSize.w - r.width),
              y: clamp(Math.round(d.orig.y + dy), 0, videoSize.h - r.height),
            };
          }
          // resize (góc phải-dưới)
          return {
            ...r,
            width: clamp(Math.round(d.orig.width + dx), 24, videoSize.w - r.x),
            height: clamp(Math.round(d.orig.height + dy), 16, videoSize.h - r.y),
          };
        })
      );
    };
    const onUp = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [regions, videoSize, onChange]);

  const startDrag = (e, region, mode) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(region.id);
    drag.current = { id: region.id, mode, startX: e.clientX, startY: e.clientY, orig: { ...region } };
  };

  const pct = (val, total) => `${(Number(val) / Math.max(1, total)) * 100}%`;

  const addRegion = () => {
    const v = videoRef.current;
    const t = v?.currentTime ?? 0;
    const w = videoSize?.w ?? 1280;
    const h = videoSize?.h ?? 720;
    tmpSeq += 1;
    const nr = {
      id: `tmp_${Date.now()}_${tmpSeq}`,
      startSec: round1(Math.max(0, t - 1.5)),
      endSec: round1(t + 1.5),
      x: Math.round(w * 0.15),
      y: Math.round(h * 0.78),
      width: Math.round(w * 0.7),
      height: Math.round(h * 0.12),
      source: 'MANUAL',
      text: '',
    };
    onChange([...regions, nr]);
    setSelectedId(nr.id);
  };

  const removeSelected = () => {
    if (!selectedId) return;
    onChange(regions.filter((r) => r.id !== selectedId));
    setSelectedId(null);
  };

  const updateSelectedTime = (field, val) => {
    if (!selected) return;
    const num = Number(val);
    if (Number.isNaN(num)) return;
    onChange(regions.map((r) => (r.id === selected.id ? { ...r, [field]: round1(Math.max(0, num)) } : r)));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500 leading-relaxed flex items-center gap-1.5">
          <ScanText className="w-3.5 h-3.5 shrink-0" />
          Tạm dừng video ở thời điểm cần, kéo/thả hoặc resize các ô xanh để chỉnh đúng vùng phụ đề cứng.
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={addRegion}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-white/25 text-xs font-medium transition">
            <Plus className="w-3.5 h-3.5" /> Thêm vùng
          </button>
          <button onClick={removeSelected} disabled={!selected}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs font-medium transition disabled:opacity-30">
            <Trash2 className="w-3.5 h-3.5" /> Xoá vùng
          </button>
        </div>
      </div>

      <div ref={wrapRef} className="relative rounded-xl overflow-hidden bg-black select-none">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            className="w-full max-h-[420px]"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              setVideoSize({ w: el.videoWidth || 1280, h: el.videoHeight || 720 });
            }}
          />
        ) : (
          <div className="w-full aspect-video flex items-center justify-center text-sm text-slate-500">
            Chưa có video nguồn để xem trước vùng che
          </div>
        )}

        {/* Overlay các region — toạ độ % theo kích thước video gốc */}
        {videoSize &&
          regions.map((r) => {
            const isSel = r.id === selectedId;
            return (
              <div key={r.id}
                onPointerDown={(e) => startDrag(e, r, 'move')}
                className={`absolute cursor-move ${isSel ? 'border-2 border-blue-400 bg-blue-500/20' : 'border-2 border-emerald-400/70 bg-emerald-500/10 hover:bg-emerald-500/20'}`}
                style={{ left: pct(r.x, videoSize.w), top: pct(r.y, videoSize.h), width: pct(r.width, videoSize.w), height: pct(r.height, videoSize.h) }}
                title={r.source === 'MANUAL' ? 'Vùng thủ công' : `OCR: ${r.text || '(không đọc được)'}`}>
                {isSel && (
                  <>
                    <span className={`absolute -top-0.5 -left-0.5 w-3 h-3 ${r.source === 'MANUAL' ? 'bg-blue-400' : 'bg-emerald-400'} rounded-tl`} />
                    <span className="absolute top-0 right-1 text-[9px] font-mono text-white/80 pointer-events-none">{fmtRange(r)}</span>
                    {/* resize handle */}
                    <span
                      onPointerDown={(e) => startDrag(e, r, 'resize')}
                      className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-blue-400 border-2 border-[#161922] rounded-full cursor-nwse-resize"
                    />
                  </>
                )}
              </div>
            );
          })}
      </div>

      {selected && (
        <div className="flex flex-wrap items-end gap-4 text-xs">
          <label className="space-y-1">
            <span className="block text-slate-500">Bắt đầu (giây)</span>
            <input type="number" step="0.1" min="0" value={selected.startSec}
              onChange={(e) => updateSelectedTime('startSec', e.target.value)}
              className="w-28 px-3 py-1.5 rounded-lg bg-[#0F1117] border border-white/10 text-slate-200 focus:outline-none focus:border-blue-500/50" />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-500">Kết thúc (giây)</span>
            <input type="number" step="0.1" min="0" value={selected.endSec}
              onChange={(e) => updateSelectedTime('endSec', e.target.value)}
              className="w-28 px-3 py-1.5 rounded-lg bg-[#0F1117] border border-white/10 text-slate-200 focus:outline-none focus:border-blue-500/50" />
          </label>
          <span className="text-slate-600 pb-2">
            {Math.round(selected.width)}×{Math.round(selected.height)}px @ ({Math.round(selected.x)}, {Math.round(selected.y)}) • {selected.source === 'MANUAL' ? 'Thủ công' : 'AI tự phát hiện'}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-slate-600">{regions.length} vùng che chữ</p>
        <button onClick={onSave} disabled={saving || !onSave}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition disabled:opacity-40">
          {saving ? 'Đang lưu...' : 'Lưu vùng che'}
        </button>
      </div>
      {(saveError || (!videoUrl && regions.length > 0)) && (
        <p className={`text-xs ${saveError ? 'text-red-400' : 'text-slate-500'}`}>{saveError || ''}</p>
      )}
    </div>
  );
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function fmtRange(r) {
  return `${round1(r.startSec)}s–${round1(r.endSec)}s`;
}
