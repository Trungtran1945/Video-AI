import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ScanText,
  Languages,
  Sparkles,
  Check,
  X,
  Loader2,
  Plus,
  Type,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import { projectsApi } from '@/api/projects';
import { TARGET_LANGUAGES } from '@/lib/constants';

export default function OcrTranslateModal({ isOpen, onClose, asset, projectId, onAddOverlay }) {
  const [loadingOcr, setLoadingOcr] = useState(false);
  const [loadingTranslate, setLoadingTranslate] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [targetLang, setTargetLang] = useState('vi');
  const [selectedSource, setSelectedSource] = useState('translation'); // 'translation' | 'ocr'
  const [overlayPosition, setOverlayPosition] = useState('bottom'); // 'bottom' | 'center' | 'top'
  const [error, setError] = useState('');
  const [hasScanned, setHasScanned] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !asset) return;
    setError('');
    const initialOcr = asset.ocrText || '';
    const initialTrans = asset.translationText || '';
    const initialLang = asset.translationTargetLang || 'vi';

    setOcrText(initialOcr);
    setTranslatedText(initialTrans);
    setTargetLang(initialLang);
    setHasScanned(Boolean(initialOcr));
    setSelectedSource(initialTrans ? 'translation' : 'ocr');

    let cancelled = false;

    // Case 1: No OCR text yet -> auto-run OCR, then auto-translate
    if (!initialOcr) {
      (async () => {
        setLoadingOcr(true);
        setError('');
        try {
          const res = await projectsApi.runOcr(projectId, asset.id);
          if (cancelled) return;
          const text = res.text || '';
          setOcrText(text);
          setHasScanned(true);

          if (text) {
            setLoadingTranslate(true);
            try {
              const tRes = await projectsApi.runTranslate(projectId, asset.id, {
                text,
                targetLanguage: initialLang,
              });
              if (!cancelled) {
                const trans = tRes.translatedText || '';
                setTranslatedText(trans);
                setSelectedSource(trans ? 'translation' : 'ocr');
              }
            } catch (tErr) {
              if (!cancelled) setError(tErr?.response?.data?.message || 'Lỗi dịch thuật văn bản');
            } finally {
              if (!cancelled) setLoadingTranslate(false);
            }
          }
        } catch (err) {
          if (!cancelled) setError(err?.response?.data?.message || 'Không thể quét chữ trên ảnh');
        } finally {
          if (!cancelled) setLoadingOcr(false);
        }
      })();
    }
    // Case 2: Has OCR text but no translation -> auto-run translate
    else if (initialOcr && !initialTrans) {
      (async () => {
        setLoadingTranslate(true);
        try {
          const tRes = await projectsApi.runTranslate(projectId, asset.id, {
            text: initialOcr,
            targetLanguage: initialLang,
          });
          if (!cancelled) {
            const trans = tRes.translatedText || '';
            setTranslatedText(trans);
            setSelectedSource(trans ? 'translation' : 'ocr');
          }
        } catch (tErr) {
          if (!cancelled) setError(tErr?.response?.data?.message || 'Lỗi dịch thuật văn bản');
        } finally {
          if (!cancelled) setLoadingTranslate(false);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, asset?.id]);

  const handleRunOcr = async () => {
    if (!asset) return;
    setLoadingOcr(true);
    setError('');
    try {
      const res = await projectsApi.runOcr(projectId, asset.id);
      const text = res.text || '';
      setOcrText(text);
      setHasScanned(true);
      if (text) {
        await handleTranslate(text, targetLang);
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
      const trans = res.translatedText || '';
      setTranslatedText(trans);
      if (trans) setSelectedSource('translation');
    } catch (err) {
      setError(err?.response?.data?.message || 'Lỗi dịch thuật văn bản');
    } finally {
      setLoadingTranslate(false);
    }
  };

  const handleAddToTimeline = () => {
    const textToAdd =
      selectedSource === 'translation'
        ? (translatedText || ocrText || '').trim()
        : (ocrText || translatedText || '').trim();

    if (!textToAdd) return;

    onAddOverlay?.({
      assetId: asset.id,
      text: textToAdd,
      style: {
        fontSize: 28,
        color: '#FFFFFF',
        bg: 'rgba(0,0,0,0.65)',
        position: overlayPosition,
      },
    });
    onClose();
  };

  if (!isOpen || !asset) return null;

  return (
    <AnimatePresence>
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs select-none"
      >
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
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
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
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Nhận diện chữ trên ảnh và dịch sang ngôn ngữ mong muốn để hiển thị phụ đề trực quan.
                </p>
                <div className="pt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRunOcr}
                    disabled={loadingOcr}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium transition cursor-pointer"
                  >
                    {loadingOcr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanText className="w-3.5 h-3.5" />}
                    <span>{loadingOcr ? 'Đang quét...' : 'Quét lại chữ'}</span>
                  </button>
                  {ocrText && !loadingOcr && (
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" /> Đã quét xong
                    </span>
                  )}
                  {hasScanned && !ocrText && !loadingOcr && (
                    <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <HelpCircle className="w-3.5 h-3.5" /> Không tìm thấy chữ trên ảnh
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
                {ocrText && (
                  <button
                    type="button"
                    onClick={() => setSelectedSource('ocr')}
                    className={`text-[11px] px-2 py-0.5 rounded transition cursor-pointer ${
                      selectedSource === 'ocr'
                        ? 'bg-primary text-primary-foreground font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Dùng bản gốc này
                  </button>
                )}
              </div>
              <textarea
                value={ocrText}
                onChange={(e) => setOcrText(e.target.value)}
                placeholder="Chưa phát hiện văn bản nào..."
                rows={2}
                className="w-full px-3 py-2 text-xs rounded-xl bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary/40 text-foreground"
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
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Bản dịch (cho phép sửa tay trực tiếp):
                  </label>
                  {translatedText && (
                    <button
                      type="button"
                      onClick={() => setSelectedSource('translation')}
                      className={`text-[11px] px-2 py-0.5 rounded transition cursor-pointer ${
                        selectedSource === 'translation'
                          ? 'bg-primary text-primary-foreground font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Dùng bản dịch này
                    </button>
                  )}
                </div>
                <div className="relative">
                  <textarea
                    value={translatedText}
                    onChange={(e) => setTranslatedText(e.target.value)}
                    placeholder="Bản dịch sẽ xuất hiện tại đây..."
                    rows={2}
                    className="w-full px-3 py-2 text-xs rounded-xl bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary/40 text-foreground"
                  />
                  {loadingTranslate && (
                    <div className="absolute inset-0 bg-background/60 rounded-xl flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-primary animate-spin" />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Vị trí hiển thị:</span>
                  <div className="inline-flex rounded-lg border border-border p-0.5 bg-background">
                    {['top', 'center', 'bottom'].map((pos) => (
                      <button
                        key={pos}
                        type="button"
                        onClick={() => setOverlayPosition(pos)}
                        className={`px-2 py-0.5 text-[11px] rounded capitalize transition cursor-pointer ${
                          overlayPosition === pos
                            ? 'bg-primary text-primary-foreground font-semibold'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {pos === 'top' ? 'Trên' : pos === 'center' ? 'Giữa' : 'Dưới'}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleTranslate(ocrText, targetLang)}
                  disabled={loadingTranslate || !ocrText.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium text-foreground transition disabled:opacity-50 cursor-pointer"
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
              className="px-3.5 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition cursor-pointer"
            >
              Hủy bỏ
            </button>
            <button
              type="button"
              onClick={handleAddToTimeline}
              disabled={!translatedText.trim() && !ocrText.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition disabled:opacity-50 shadow-xs cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>
                Thêm vào Video ({selectedSource === 'translation' ? 'Bản dịch' : 'Bản gốc'})
              </span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
