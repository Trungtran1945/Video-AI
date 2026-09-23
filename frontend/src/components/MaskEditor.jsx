import { useState, useEffect, useCallback, useRef } from 'react';
import { projectsApi } from '@/api/projects';
import { Plus, Trash2, Eye, EyeOff, Copy, Loader2, AlertCircle, Scissors, Check } from 'lucide-react';

const toPct = (r) => Math.round(Number(r || 0) * 1000) / 10;
const toRatio = (p) => Math.min(1, Math.max(0, Number(p) / 100));

function isAuto(m) {
  return String(m?.id || '').startsWith('auto:') || String(m?.source || '').toUpperCase() === 'AUTO';
}

function inTime(m, t) {
  return Number(m.startSec) <= t && t <= Number(m.endSec);
}

export default function MaskEditor({ projectId, sourceUrl, disabled }) {
  const [masks, setMasks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [contentBox, setContentBox] = useState(null); // vùng video thật trong container (letterbox-aware)
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const gestureRef = useRef(null);

  const selected = masks.find((m) => String(m.id) === String(selectedId)) || null;

  const load = useCallback(async () => {
    try {
      const res = await projectsApi.masks(projectId);
      const list = Array.isArray(res) ? res : res?.masks || [];
      setMasks(list);
      setError('');
    } catch (e) {
      setError('Không tải được masks: ' + (e?.response?.data?.message || e.message));
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) load();
  }, [projectId, load]);

  // Tính vùng video content thật (object-contain có letterbox) để overlay khớp pixel.
  const measure = useCallback(() => {
    const video = videoRef.current;
    const box = containerRef.current;
    if (!video || !box || !video.videoWidth) return;
    const cw = box.clientWidth;
    const ch = box.clientHeight;
    const scale = Math.min(cw / video.videoWidth, ch / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    setContentBox({ x: (cw - w) / 2, y: (ch - h) / 2, w, h });
  }, []);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const patchMask = useCallback(async (maskId, patch) => {
    setSaving(true);
    setError('');
    try {
      const updated = await projectsApi.updateMask(projectId, maskId, patch);
      setMasks((prev) => prev.map((m) => (String(m.id) === String(maskId) ? { ...m, ...updated } : m)));
      return updated;
    } catch (e) {
      setError('Không lưu được mask: ' + (e?.response?.data?.message || e.message));
      return null;
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const handleAdd = async () => {
    setSaving(true);
    setError('');
    try {
      const t = Number(currentTime) || 0;
      const created = await projectsApi.createMask(projectId, {
        ratioX: 0.25, ratioY: 0.65, ratioW: 0.5, ratioH: 0.2,
        startSec: Math.max(0, t), endSec: Math.max(0, t) + 2,
        type: 'blur', blurRadius: 8, opacity: 1, enabled: true, status: 'DRAFT',
      });
      setMasks((prev) => [...prev, created]);
      setSelectedId(created.id);
    } catch (e) {
      setError('Không tạo được mask: ' + (e?.response?.data?.message || e.message));
    } finally {
      setSaving(false);
    }
  };

  // §2 approve lifecycle: DRAFT → APPROVED (render burn thật) | DISABLED.
  // Chưa chọn mask hoặc mask AUTO → nút Approve disabled.
  const canApprove = selected && !isAuto(selected) && selected.status !== 'APPROVED' && !disabled && !saving;
  const handleApprove = async () => {
    if (!canApprove) return;
    setSaving(true);
    setError('');
    try {
      const updated = await projectsApi.updateMask(projectId, selected.id, { status: 'APPROVED' });
      setMasks((prev) => prev.map((m) => (String(m.id) === String(selected.id) ? { ...m, ...updated } : m)));
    } catch (e) {
      setError('Không approve được mask: ' + (e?.response?.data?.message || e.message));
    } finally {
      setSaving(false);
    }
  };

  // Eye toggle chuyển trạng thái DISABLED ↔ APPROVED (giữ row, render bỏ qua/khôi phục).
  const handleToggleEnabled = async (m) => {
    const toDisabled = m.status === 'APPROVED' || (m.status !== 'DISABLED' && m.enabled);
    await patchMask(m.id, toDisabled ? { status: 'DISABLED' } : { status: 'APPROVED' });
  };

  const statusBadge = (m) => {
    if (isAuto(m)) return 'AUTO';
    return m.status === 'APPROVED' ? 'APPROVED' : m.status === 'DISABLED' ? 'DISABLED' : 'DRAFT';
  };

  const handleDelete = async (m) => {
    if (isAuto(m)) return;
    setSaving(true);
    try {
      await projectsApi.deleteMask(projectId, m.id);
      setMasks((prev) => prev.filter((x) => String(x.id) !== String(m.id)));
      if (String(selectedId) === String(m.id)) setSelectedId(null);
    } catch (e) {
      setError('Không xoá được mask: ' + (e?.response?.data?.message || e.message));
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicateAuto = async (m) => {
    setSaving(true);
    try {
      const created = await projectsApi.createMask(projectId, {
        ratioX: m.ratioX, ratioY: m.ratioY, ratioW: m.ratioW, ratioH: m.ratioH,
        startSec: m.startSec, endSec: m.endSec,
        type: m.type === 'solid' ? 'solid' : 'blur',
        blurRadius: m.blurRadius ?? 8, opacity: m.opacity ?? 1, enabled: true, status: 'DRAFT',
        text: m.text || null,
      });
      setMasks((prev) => [...prev, created]);
      setSelectedId(created.id);
    } catch (e) {
      setError('Không nhân bản được mask: ' + (e?.response?.data?.message || e.message));
    } finally {
      setSaving(false);
    }
  };

  // Drag / resize bằng pointer events (không thêm dependency).
  const onBoxPointerDown = (e, m, mode) => {
    if (disabled || saving) return;
    if (isAuto(m)) {
      setSelectedId(m.id);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { x: m.ratioX, y: m.ratioY, w: m.ratioW, h: m.ratioH };
    gestureRef.current = { id: m.id, mode, startX, startY, orig };
    setSelectedId(m.id);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onContainerPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g || !contentBox || contentBox.w <= 0) return;
    const dx = (e.clientX - g.startX) / contentBox.w;
    const dy = (e.clientY - g.startY) / contentBox.h;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    let next = { ...g.orig };
    if (g.mode === 'move') {
      next.x = clamp01(g.orig.x + dx);
      next.y = clamp01(g.orig.y + dy);
    } else {
      if (g.mode.includes('e')) next.w = Math.min(1 - next.x, Math.max(0.02, g.orig.w + dx));
      if (g.mode.includes('s')) next.h = Math.min(1 - next.y, Math.max(0.02, g.orig.h + dy));
      if (g.mode.includes('w')) {
        const nx = clamp01(g.orig.x + dx);
        next.w = Math.max(0.02, g.orig.w - (nx - g.orig.x));
        next.x = nx;
      }
      if (g.mode.includes('n')) {
        const ny = clamp01(g.orig.y + dy);
        next.h = Math.max(0.02, g.orig.h - (ny - g.orig.y));
        next.y = ny;
      }
    }
    setMasks((prev) => prev.map((m) => (
      String(m.id) === String(g.id)
        ? { ...m, ratioX: next.x, ratioY: next.y, ratioW: next.w, ratioH: next.h }
        : m
    )));
  };

  const onContainerPointerUp = async () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    const m = masks.find((x) => String(x.id) === String(g.id));
    if (!m || isAuto(m)) return;
    await patchMask(g.id, { ratioX: m.ratioX, ratioY: m.ratioY, ratioW: m.ratioW, ratioH: m.ratioH });
  };

  const seek = (t) => {
    const video = videoRef.current;
    if (video && Number.isFinite(Number(t))) {
      try { video.currentTime = Number(t); } catch { /* noop */ }
      setCurrentTime(Number(t));
    }
  };

  const boxStyle = (m) => {
    if (!contentBox) return { display: 'none' };
    const left = contentBox.x + Number(m.ratioX) * contentBox.w;
    const top = contentBox.y + Number(m.ratioY) * contentBox.h;
    const width = Number(m.ratioW) * contentBox.w;
    const height = Number(m.ratioH) * contentBox.h;
    const active = inTime(m, currentTime);
    const base = {
      position: 'absolute', left, top, width, height,
      border: `2px ${m.type === 'solid' ? 'dashed' : 'solid'} ${active ? '#60a5fa' : 'rgba(96,165,250,0.45)'}`,
      borderRadius: 4,
      cursor: isAuto(m) ? 'pointer' : 'move',
      opacity: active ? 1 : 0.55,
      zIndex: 5,
      touchAction: 'none',
    };
    if (m.type === 'solid') {
      base.background = `rgba(0,0,0,${Number(m.opacity ?? 1)})`;
    } else {
      base.backdropFilter = `blur(${Math.max(1, Math.round(Number(m.blurRadius ?? 8) / 2))}px)`;
      base.background = 'rgba(0,0,0,0.25)';
    }
    if (String(selectedId) === String(m.id)) {
      base.boxShadow = '0 0 0 2px rgba(96,165,250,0.6)';
    }
    return base;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Scissors className="w-3.5 h-3.5" /> Che chữ thủ công
          <span className="text-[10px] font-normal text-muted-foreground">{masks.length} vùng</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleApprove}
            disabled={!canApprove}
            title={!selected ? 'Chọn một mask thủ công để approve' : isAuto(selected) ? 'Mask tự động chỉ đọc' : 'Approve mask để render burn vào video'}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
          </button>
          <button
            onClick={handleAdd}
            disabled={disabled || saving}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Thêm mask
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-[11px] text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-2 py-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      {/* Preview: video nguồn + overlay mask realtime */}
      <div
        ref={containerRef}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        className="relative w-full aspect-video bg-black rounded-xl overflow-hidden"
      >
        {sourceUrl ? (
          <video
            ref={videoRef}
            src={sourceUrl}
            controls
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-contain"
            onLoadedMetadata={(e) => { measure(); }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Chưa có video nguồn để preview mask
          </div>
        )}
        {masks.map((m) => (
          <div
            key={m.id}
            style={boxStyle(m)}
            onPointerDown={(e) => onBoxPointerDown(e, m, 'move')}
            onClick={(e) => { e.stopPropagation(); setSelectedId(m.id); seek(m.startSec); }}
            title={isAuto(m) ? 'Mask tự động (chỉ đọc)' : `Mask thủ công (${m.type})`}
          >
            {!isAuto(m) && String(selectedId) === String(m.id) && ['nw', 'ne', 'sw', 'se'].map((h) => (
              <span
                key={h}
                onPointerDown={(e) => onBoxPointerDown(e, m, h)}
                style={{
                  position: 'absolute',
                  width: 12, height: 12, borderRadius: 3, background: '#60a5fa',
                  cursor: `${h}-resize`,
                  top: h.includes('n') ? -7 : undefined,
                  bottom: h.includes('s') ? -7 : undefined,
                  left: h.includes('w') ? -7 : undefined,
                  right: h.includes('e') ? -7 : undefined,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Danh sách mask */}
      <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
        {masks.length === 0 && (
          <div className="text-[11px] text-muted-foreground px-1">Chưa có mask — Thêm mask hoặc chạy OCR để có mask tự động.</div>
        )}
        {masks.map((m) => (
          <div
            key={m.id}
            onClick={() => { setSelectedId(m.id); seek(m.startSec); }}
            className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded-md cursor-pointer border ${
              String(selectedId) === String(m.id) ? 'border-primary/60 bg-primary/10' : 'border-border hover:bg-muted'
            }`}
          >
            <span className={`shrink-0 px-1 rounded text-[9px] ${
              isAuto(m) ? 'bg-emerald-500/15 text-emerald-400'
              : m.status === 'APPROVED' ? 'bg-emerald-500/15 text-emerald-300'
              : m.status === 'DISABLED' ? 'bg-slate-500/15 text-slate-400'
              : 'bg-amber-500/15 text-amber-300'
            }`}>
              {statusBadge(m)}
            </span>
            <span className="flex-1 truncate">{m.text || `${m.type} ${toPct(m.ratioW)}×${toPct(m.ratioH)}%`}</span>
            <span className="text-muted-foreground shrink-0">{Number(m.startSec).toFixed(1)}–{Number(m.endSec).toFixed(1)}s</span>
            {!isAuto(m) && (
              <button
                onClick={(e) => { e.stopPropagation(); handleToggleEnabled(m); }}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title={m.status === 'DISABLED' ? 'Bật lại (APPROVED)' : 'Tắt mask (DISABLED)'}
              >
                {m.status === 'DISABLED' ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Form chỉnh mask đang chọn */}
      {selected && (
        <MaskForm
          key={selected.id}
          mask={selected}
          readOnly={isAuto(selected)}
          disabled={disabled || saving}
          onCommit={(patch) => patchMask(selected.id, patch)}
          onDelete={() => handleDelete(selected)}
          onDuplicate={() => handleDuplicateAuto(selected)}
        />
      )}
    </div>
  );
}

function NumField({ label, value, step = 0.5, min, max, onCommit, suffix, disabled }) {
  const [v, setV] = useState(String(value ?? ''));
  useEffect(() => { setV(String(value ?? '')); }, [value]);
  return (
    <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
      {label}{suffix ? ` (${suffix})` : ''}
      <input
        type="number"
        value={v}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Number(v); if (Number.isFinite(n)) onCommit(n); else setV(String(value ?? '')); }}
        className="w-full bg-background border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground disabled:opacity-50"
      />
    </label>
  );
}

function MaskForm({ mask, readOnly, disabled, onCommit, onDelete, onDuplicate }) {
  const locked = readOnly || disabled;
  return (
    <div className="border border-border rounded-xl p-2 flex flex-col gap-2 bg-card">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold">
          {readOnly ? 'Mask tự động (chỉ đọc)' : `Chỉnh mask thủ công — ${mask.status || 'DRAFT'}`}
        </span>
        <div className="flex items-center gap-1">
          {readOnly ? (
            <button
              onClick={onDuplicate}
              disabled={disabled}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            >
              <Copy className="w-3 h-3" /> Nhân bản tay
            </button>
          ) : (
            <button
              onClick={onDelete}
              disabled={disabled}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" /> Xoá
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <NumField label="X" suffix="%" value={toPct(mask.ratioX)} min={0} max={100} disabled={locked} onCommit={(n) => onCommit({ ratioX: toRatio(n) })} />
        <NumField label="Y" suffix="%" value={toPct(mask.ratioY)} min={0} max={100} disabled={locked} onCommit={(n) => onCommit({ ratioY: toRatio(n) })} />
        <NumField label="Rộng" suffix="%" value={toPct(mask.ratioW)} min={1} max={100} disabled={locked} onCommit={(n) => onCommit({ ratioW: toRatio(n) })} />
        <NumField label="Cao" suffix="%" value={toPct(mask.ratioH)} min={1} max={100} disabled={locked} onCommit={(n) => onCommit({ ratioH: toRatio(n) })} />
        <NumField label="Bắt đầu" suffix="s" value={Math.round(Number(mask.startSec) * 10) / 10} step={0.1} min={0} disabled={locked} onCommit={(n) => onCommit({ startSec: n })} />
        <NumField label="Kết thúc" suffix="s" value={Math.round(Number(mask.endSec) * 10) / 10} step={0.1} min={0} disabled={locked} onCommit={(n) => onCommit({ endSec: n })} />
        <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
          Kiểu
          <select
            value={mask.type === 'solid' ? 'solid' : 'blur'}
            disabled={locked}
            onChange={(e) => onCommit({ type: e.target.value })}
            className="w-full bg-background border border-border rounded-md px-1.5 py-1 text-[11px] text-foreground disabled:opacity-50"
          >
            <option value="blur">Làm mờ</option>
            <option value="solid">Che phủ</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-foreground pt-4">
          <input
            type="checkbox"
            checked={!!mask.enabled}
            disabled={locked}
            onChange={(e) => onCommit({ enabled: e.target.checked })}
          />
          Bật
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
        Bán kính mờ: {mask.blurRadius ?? 8}
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={Number(mask.blurRadius ?? 8)}
          disabled={locked || mask.type === 'solid'}
          onChange={(e) => onCommit({ blurRadius: Number(e.target.value) })}
          className="w-full"
        />
      </label>
      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
        Độ đục: {Math.round(Number(mask.opacity ?? 1) * 100)}%
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(Number(mask.opacity ?? 1) * 100)}
          disabled={locked}
          onChange={(e) => onCommit({ opacity: Number(e.target.value) / 100 })}
          className="w-full"
        />
      </label>
    </div>
  );
}
