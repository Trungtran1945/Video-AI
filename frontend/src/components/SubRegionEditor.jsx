import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, ScanText, Merge, Layers } from 'lucide-react'
import { Slider } from '@/components/ui/slider'

let tmpSeq = 0

/**
 * SubRegionEditor — chỉnh vùng che hardsub trên khung hình video tạm dừng.
 * - Tọa độ lưu theo TỶ LỆ (ratioX/Y/W/H 0..1) → scale-invariant (docs/02 §2, docs/04 §4.1).
 * - Live preview: vùng được LÀM MỜ THỰC SỰ (backdrop blur) + lớp phủ mờ, không thấy rõ chữ gốc.
 * - Thanh kéo maskStrength (0..1) tăng/giảm ĐỒNG THỜI bán kính blur và độ đục lớp phủ.
 * - "Áp dụng cho toàn bộ video" (isStatic) cho hardsub tĩnh; "Gộp vùng" (Merge) gộp nhiều region.
 */
export default function SubRegionEditor({ videoUrl, regions = [], onChange, onSave, saving, saveError, compact = false }) {
  const videoRef = useRef(null)
  const wrapRef = useRef(null)
  const [videoSize, setVideoSize] = useState(null); // { w, h } intrinsic
  const [videoDuration, setVideoDuration] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const drag = useRef(null)

  const selected = regions.find((r) => r.id === selectedId) || null

  // Luôn gắn listener trên window; chỉ xử lý khi đang kéo (drag.current != null).
  useEffect(() => {
    const onMove = (e) => {
      const d = drag.current
      if (!d) return
      const box = wrapRef.current?.getBoundingClientRect()
      if (!box) return
      const scaleX = 1 / box.width
      const scaleY = 1 / box.height
      const dx = (e.clientX - d.startX) * scaleX
      const dy = (e.clientY - d.startY) * scaleY
      onChange(
        regions.map((r) => {
          if (r.id !== d.id) return r
          if (d.mode === 'move') {
            return {
              ...r,
              ratioX: clamp(d.orig.ratioX + dx, 0, 1 - r.ratioW),
              ratioY: clamp(d.orig.ratioY + dy, 0, 1 - r.ratioH),
            }
          }
          // resize (góc phải-dưới)
          return {
            ...r,
            ratioW: clamp(d.orig.ratioW + dx, 0.02, 1 - r.ratioX),
            ratioH: clamp(d.orig.ratioH + dy, 0.015, 1 - r.ratioY),
          }
        })
      )
    }
    const onUp = () => {
      drag.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [regions, onChange])

  const startDrag = (e, region, mode) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(region.id)
    drag.current = { id: region.id, mode, startX: e.clientX, startY: e.clientY, orig: { ...region } }
  }

  const addRegion = () => {
    const v = videoRef.current
    const t = v?.currentTime ?? 0
    tmpSeq += 1
    const nr = {
      id: `tmp_${Date.now()}_${tmpSeq}`,
      startSec: round1(Math.max(0, t - 1.5)),
      endSec: round1(t + 1.5),
      ratioX: 0.15,
      ratioY: 0.78,
      ratioW: 0.7,
      ratioH: 0.12,
      maskStrength: 0.6,
      isStatic: false,
      source: 'MANUAL',
      text: '',
    }
    onChange([...regions, nr])
    setSelectedId(nr.id)
  }

  const removeSelected = () => {
    if (!selectedId) return
    onChange(regions.filter((r) => r.id !== selectedId))
    setSelectedId(null)
  }

  // Gộp tất cả vùng thành 1 bbox bao trùm (tỷ lệ) — cho hardsub tĩnh rải rác.
  const mergeRegions = () => {
    if (regions.length < 2) return
    const minX = Math.min(...regions.map((r) => r.ratioX))
    const minY = Math.min(...regions.map((r) => r.ratioY))
    const maxX = Math.max(...regions.map((r) => r.ratioX + r.ratioW))
    const maxY = Math.max(...regions.map((r) => r.ratioY + r.ratioH))
    const merged = {
      id: `tmp_${Date.now()}_${++tmpSeq}`,
      startSec: Math.min(...regions.map((r) => r.startSec)),
      endSec: Math.max(...regions.map((r) => r.endSec)),
      ratioX: round3(minX),
      ratioY: round3(minY),
      ratioW: round3(maxX - minX),
      ratioH: round3(maxY - minY),
      maskStrength: regions[0]?.maskStrength ?? 0.6,
      isStatic: false,
      source: 'MANUAL',
      text: '',
    }
    onChange([merged])
    setSelectedId(merged.id)
  }

  const updateSelected = (field, val) => {
    if (!selected) return
    onChange(regions.map((r) => (r.id === selected.id ? { ...r, [field]: val } : r)))
  }

  const updateSelectedTime = (field, val) => {
    if (!selected) return
    const num = Number(val)
    if (Number.isNaN(num)) return
    updateSelected(field, round1(Math.max(0, num)))
  }

  const toggleStatic = (e) => {
    if (!selected) return
    const checked = e.target.checked
    updateSelected(
      'isStatic',
      checked
        ? true
        : false
    )
    // isStatic → trải dài toàn bộ video
    if (checked) {
      updateSelected('startSec', 0)
      updateSelected('endSec', round1(videoDuration || selected.endSec))
    }
  }

  // Tính blur (px) + độ đục lớp phủ từ maskStrength (cùng 1 tham số "độ mờ").
  const blurOf = (s) => Math.round(4 + clamp(Number(s) ?? 0.6, 0, 1) * 18) // 4–22px
  const opacityOf = (s) => 0.1 + clamp(Number(s) ?? 0.6, 0, 1) * 0.75 // 0.1–0.85

  // Compact mode for2-panel layout (video handled by parent)
  if (compact) {
    return (
      <div className="h-full flex flex-col">
        {/* Compact toolbar */}
        <div className="shrink-0 flex items-center justify-between gap-2 p-2 bg-black/50 backdrop-blur-sm">
          <div className="flex gap-1 shrink-0">
            <button onClick={addRegion}
              className="flex items-center gap-1 px-2 py-1 rounded border border-white/10 text-slate-300 hover:border-white/25 text-[10px] font-medium transition">
              <Plus className="w-3 h-3" /> Thêm
            </button>
            <button onClick={mergeRegions} disabled={regions.length < 2}
              className="flex items-center gap-1 px-2 py-1 rounded border border-white/10 text-slate-300 hover:border-white/25 text-[10px] font-medium transition disabled:opacity-30">
              <Merge className="w-3 h-3" /> Gộp
            </button>
            <button onClick={removeSelected} disabled={!selected}
              className="flex items-center gap-1 px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 text-[10px] font-medium transition disabled:opacity-30">
              <Trash2 className="w-3 h-3" /> Xoá
            </button>
          </div>
          <p className="text-[10px] text-slate-500 flex items-center gap-1">
            <ScanText className="w-3 h-3 shrink-0" />
            Kéo/thả vùng che chữ
          </p>
        </div>

        {/* Region overlays on parent's video */}
        <div ref={wrapRef} className="relative flex-1 min-h-0 select-none" />

        {/* Selected region controls */}
        {selected && (
          <div className="shrink-0 p-2 bg-black/50 backdrop-blur-sm space-y-1">
            <div className="flex items-center gap-2 text-[10px]">
              <label className="flex items-center gap-1">
                <span className="text-slate-500">Bắt đầu:</span>
                <input type="number" step="0.1" min="0" value={selected.startSec}
                  disabled={selected.isStatic}
                  onChange={(e) => updateSelectedTime('startSec', e.target.value)}
                  className="w-16 px-1.5 py-0.5 rounded bg-[#0F1117] border border-white/10 text-slate-200 text-[10px] focus:outline-none focus:border-blue-500/50 disabled:opacity-40" />
              </label>
              <label className="flex items-center gap-1">
                <span className="text-slate-500">Kết thúc:</span>
                <input type="number" step="0.1" min="0" value={selected.endSec}
                  disabled={selected.isStatic}
                  onChange={(e) => updateSelectedTime('endSec', e.target.value)}
                  className="w-16 px-1.5 py-0.5 rounded bg-[#0F1117] border border-white/10 text-slate-200 text-[10px] focus:outline-none focus:border-blue-500/50 disabled:opacity-40" />
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={!!selected.isStatic} onChange={toggleStatic}
                  className="accent-blue-500 w-3 h-3" />
                <span className="text-slate-300"><Layers className="w-3 h-3 inline" /> Toàn bộ</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400">Độ mờ: {Math.round((Number(selected.maskStrength) || 0.6) * 100)}%</span>
              <Slider
                value={[Number(selected.maskStrength) || 0.6]}
                min={0} max={1} step={0.01}
                onValueChange={(v) => updateSelected('maskStrength', v[0])}
                className="flex-1"
              />
              <button onClick={onSave} disabled={saving || !onSave}
                className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-medium transition disabled:opacity-40">
                {saving ? '...' : 'Lưu'}
              </button>
            </div>
          </div>
        )}

        {/* Region count */}
        {!selected && (
          <div className="shrink-0 flex items-center justify-between p-2 bg-black/50 backdrop-blur-sm">
            <p className="text-[10px] text-slate-600">{regions.length} vùng che chữ</p>
            <button onClick={onSave} disabled={saving || !onSave}
              className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-medium transition disabled:opacity-40">
              {saving ? '...' : 'Lưu'}
            </button>
          </div>
        )}

        {saveError && <p className="text-[10px] text-red-400 px-2">{saveError}</p>}

        {/* Overlay regions (after wrapRef is mounted) */}
        {regions.map((r) => {
          const isSel = r.id === selectedId
          const blur = blurOf(r.maskStrength)
          const op = opacityOf(r.maskStrength)
          return (
            <div key={r.id}
              onPointerDown={(e) => startDrag(e, r, 'move')}
              className={`absolute cursor-move ${isSel ? 'border-2 border-blue-400' : 'border-2 border-emerald-400/70 hover:border-emerald-300'}`}
              style={{
                left: `${r.ratioX * 100}%`,
                top: `${r.ratioY * 100}%`,
                width: `${r.ratioW * 100}%`,
                height: `${r.ratioH * 100}%`,
                backdropFilter: `blur(${blur}px)`,
                WebkitBackdropFilter: `blur(${blur}px)`,
                backgroundColor: `rgba(15,17,23,${op})`,
              }}
              title={r.source === 'MANUAL' ? 'Vùng thủ công' : `OCR: ${r.text || '(không đọc được)'}`}>
              {isSel && (
                <>
                  <span className={`absolute -top-0.5 -left-0.5 w-2 h-2 ${r.source === 'MANUAL' ? 'bg-blue-400' : 'bg-emerald-400'} rounded-tl`} />
                  <span
                    onPointerDown={(e) => startDrag(e, r, 'resize')}
                    className="absolute -bottom-1 -right-1 w-3 h-3 bg-blue-400 border-2 border-[#161922] rounded-full cursor-nwse-resize"
                  />
                </>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Full mode (original)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500 leading-relaxed flex items-center gap-1.5">
          <ScanText className="w-3.5 h-3.5 shrink-0" />
          Tạm dừng video ở thời điểm cần, kéo/thả hoặc resize các ô xanh để chỉnh đúng vùng phụ đề cứng.
          Vùng được làm mờ thực sự (xem trước mask).
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={addRegion}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-white/25 text-xs font-medium transition">
            <Plus className="w-3.5 h-3.5" /> Thêm vùng
          </button>
          <button onClick={mergeRegions} disabled={regions.length < 2}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-white/25 text-xs font-medium transition disabled:opacity-30">
            <Merge className="w-3.5 h-3.5" /> Gộp vùng
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
              const el = e.currentTarget
              setVideoSize({ w: el.videoWidth || 1280, h: el.videoHeight || 720 })
              setVideoDuration(el.duration || 0)
            }}
          />
        ) : (
          <div className="w-full aspect-video flex items-center justify-center text-sm text-slate-500">
            Chưa có video nguồn để xem trước vùng che
          </div>
        )}

        {/* Overlay các region — TỶ LỆ % so với kích thước video; làm mờ thực sự + lớp phủ */}
        {videoSize &&
          regions.map((r) => {
            const isSel = r.id === selectedId
            const blur = blurOf(r.maskStrength)
            const op = opacityOf(r.maskStrength)
            return (
              <div key={r.id}
                onPointerDown={(e) => startDrag(e, r, 'move')}
                className={`absolute cursor-move ${isSel ? 'border-2 border-blue-400' : 'border-2 border-emerald-400/70 hover:border-emerald-300'}`}
                style={{
                  left: `${r.ratioX * 100}%`,
                  top: `${r.ratioY * 100}%`,
                  width: `${r.ratioW * 100}%`,
                  height: `${r.ratioH * 100}%`,
                  backdropFilter: `blur(${blur}px)`,
                  WebkitBackdropFilter: `blur(${blur}px)`,
                  backgroundColor: `rgba(15,17,23,${op})`,
                }}
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
            )
          })}
      </div>

      {selected && (
        <div className="flex flex-wrap items-end gap-4 text-xs">
          <label className="space-y-1">
            <span className="block text-slate-500">Bắt đầu (giây)</span>
            <input type="number" step="0.1" min="0" value={selected.startSec}
              disabled={selected.isStatic}
              onChange={(e) => updateSelectedTime('startSec', e.target.value)}
              className="w-28 px-3 py-1.5 rounded-lg bg-[#0F1117] border border-white/10 text-slate-200 focus:outline-none focus:border-blue-500/50 disabled:opacity-40" />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-500">Kết thúc (giây)</span>
            <input type="number" step="0.1" min="0" value={selected.endSec}
              disabled={selected.isStatic}
              onChange={(e) => updateSelectedTime('endSec', e.target.value)}
              className="w-28 px-3 py-1.5 rounded-lg bg-[#0F1117] border border-white/10 text-slate-200 focus:outline-none focus:border-blue-500/50 disabled:opacity-40" />
          </label>
          <label className="flex items-center gap-2 pb-2 cursor-pointer">
            <input type="checkbox" checked={!!selected.isStatic} onChange={toggleStatic}
              className="accent-blue-500 w-4 h-4" />
            <span className="text-slate-300 flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> Áp dụng cho toàn bộ video</span>
          </label>
          <span className="text-slate-600 pb-2">
            {Math.round(selected.ratioW * 100)}%×{Math.round(selected.ratioH * 100)}% @ ({Math.round(selected.ratioX * 100)}%, {Math.round(selected.ratioY * 100)}%) • {selected.source === 'MANUAL' ? 'Thủ công' : 'AI tự phát hiện'}
          </span>
        </div>
      )}

      {selected && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Độ mờ (blur + lớp phủ): {Math.round((Number(selected.maskStrength) || 0.6) * 100)}%</span>
            <span className="text-[10px] text-slate-600">kéo để tăng/giảm</span>
          </div>
          <Slider
            value={[Number(selected.maskStrength) || 0.6]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={(v) => updateSelected('maskStrength', v[0])}
            className="w-full"
          />
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
  )
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function round1(v) {
  return Math.round(v * 10) / 10
}

function round3(v) {
  return Math.round(v * 1000) / 1000
}

function fmtRange(r) {
  return `${round1(r.startSec)}s–${round1(r.endSec)}s`
}
