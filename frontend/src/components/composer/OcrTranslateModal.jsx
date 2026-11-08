import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ScanText, Languages, Sparkles, Check, X, Loader2, Plus, Type, AlertCircle } from 'lucide-react';
import { projectsApi } from '@/api/projects';
import { TARGET_LANGUAGES } from '@/lib/constants';

export default function OcrTranslateModal({ isOpen, onClose, asset, projectId, onAddOverlay }) {
  const [loadingOcr, setLoadingOcr] = useState(false);
  const [loadingTranslate, setLoadingTranslate] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [targetLang, setTargetLang] = useState('vi');
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && asset) {
      setError('');
      setOcrText(asset.ocrText || '');
      setTranslatedText(asset.translationText || '');
      setTargetLang(asset.translationTargetLang || 'vi');

      // If not yet OCR'd, auto trigger OCR
      if (!asset.ocrText) {
        handleRunOcr();
      }
    }
  }, [isOpen, asset]);

  const handleRunOcr = async () => {
    if (!asset) return;
    setLoadingOcr(true);
    setError('');
    try {
      const res = await projectsApi.runOcr(projectId, asset.id);
      setOcrText(res.text || '');
      if (res.text && !translatedText) {
        // Auto trigger translation after OCR
        handleTranslate(res.text, targetLang);
      }
    } catch (err) {
      setError(err?.response?.data?.message || 'Không thể quét chữ trên ảnh');
    } finally {
      setLoadingOcr(false);
    }
  };

  const handleTranslate = async (sourceText = ocrText, lang = targetLang) => {
    if (!sourceText.trim()) return;
    setLoadingTranslate(true);
    setError('');
    try {
      const res = await projectsApi.runTranslate(projectId, asset.id, {
        text: sourceText,
        targetLanguage: lang,
      });
      setTranslatedText(res.translatedText || '');
    } catch (err) {
      setError(err?.response?.data?.message || 'Lỗi dịch thuật văn bản');
    } finally {
      setLoadingTranslate(false);
    }
  };

  const handleAddToTimeline = () => {
    const finalContent = (translatedText || ocrText || '').trim();
    if (!finalContent) return;
    onAddOverlay?.({
      assetId: asset.id,
      text: finalContent,
    });
    onClose();
  };

  if (!isOpen || !asset) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="w-full max-w-xl rounded-2xl bg-card border border-border shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Modal Header */}
          <div className="px-5 py-4 border-b border-border flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <ScanText className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">OCR & Dịch Thuật Hình Ảnh</h3>
                <p className="text-xs text-muted-foreground truncate max-w-xs">{asset.name}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Modal Body */}
          <div className="p-5 overflow-y-auto space-y-4 text-left">
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Image Preview & OCR Scan Status */}
            <div className="flex gap-4 items-start p-3 rounded-xl bg-muted/40 border border-border">
              <img
                src={asset.thumbnailUrl || asset.url}
                alt={asset.name}
                className="w-24 h-24 object-cover rounded-lg border border-border shrink-0 bg-black/20"
              />
              <div className="flex-1 min-w-0 space-y-1.5">
                <span className="text-xs font-semibold text-foreground block">Trích xuất chữ (OCR)</span>
                <p className="text-[11px] text-muted-foreground">
                  Hệ thống tự động phát hiện văn bản và nhãn hiệu có trong ảnh mà không can thiệp làm hỏng ảnh gốc.
                </p>
                <div className="pt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRunOcr}
                    disabled={loadingOcr}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium transition"
                  >
                    {loadingOcr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanText className="w-3.5 h-3.5" />}
                    <span>{loadingOcr ? 'Đang quét...' : 'Quét lại chữ'}</span>
                  </button>
                  {ocrText && !loadingOcr && (
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" /> Đã quét
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* OCR Original Text */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Type className="w-3.5 h-3.5 text-muted-foreground" />
                  <span>Văn bản gốc nhận diện:</span>
                </label>
              </div>
              <textarea
                value={ocrText}
                onChange={(e) => setOcrText(e.target.value)}
                placeholder="Chưa có chữ nào được nhận diện..."
                rows={2}
                className="w-full px-3 py-2 text-xs rounded-xl bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-foreground"
              />
            </div>

            {/* Translation Settings & Button */}
            <div className="p-3.5 rounded-xl bg-muted/40 border border-border space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Languages className="w-4 h-4 text-primary" />
                  <span className="text-xs font-semibold text-foreground">Dịch sang ngôn ngữ đích:</span>
                </div>
                <select
                  value={targetLang}
                  onChange={(e) => {
                    const l = e.target.value;
                    setTargetLang(l);
                    if (ocrText) handleTranslate(ocrText, l);
                  }}
                  className="px-2.5 py-1 text-xs rounded-lg bg-background border border-border text-foreground font-medium focus:outline-none"
                >
                  {Object.entries(TARGET_LANGUAGES).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Bản dịch (cho phép sửa tay trực tiếp):
                </label>
                <div className="relative">
                  <textarea
                    value={translatedText}
                    onChange={(e) => setTranslatedText(e.target.value)}
                    placeholder="Bản dịch sẽ xuất hiện tại đây..."
                    rows={2}
                    className="w-full px-3 py-2 text-xs rounded-xl bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-foreground"
                  />
                  {loadingTranslate && (
                    <div className="absolute inset-0 bg-background/60 rounded-xl flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => handleTranslate(ocrText, targetLang)}
                  disabled={loadingTranslate || !ocrText.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium text-foreground transition disabled:opacity-50"
                >
                  <Sparkles className="w-3.5 h-3.5 text-primary" />
                  <span>Dịch lại</span>
                </button>
              </div>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="px-5 py-3 border-t border-border flex items-center justify-between bg-muted/20">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition"
            >
              Hủy bỏ
            </button>
            <button
              type="button"
              onClick={handleAddToTimeline}
              disabled={!translatedText.trim() && !ocrText.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition disabled:opacity-50 shadow-xs"
            >
              <Plus className="w-4 h-4" />
              <span>Thêm vào Video (Tạo Text Overlay)</span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
