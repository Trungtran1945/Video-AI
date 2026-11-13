import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import {
  LayoutGrid,
  Layers,
  Video,
  Image as ImageIcon,
  Mic,
  Music,
  Volume2,
  Type,
  Upload,
  Trash2,
  ScanText,
  Plus,
  Loader2,
  FileAudio,
  Sparkles,
  ArrowUp,
  ArrowDown,
  Play,
  Pause,
  AlertCircle,
  X,
} from 'lucide-react';
import { projectsApi } from '@/api/projects';
import OcrTranslateModal from './OcrTranslateModal';
import TtsModal from './TtsModal';

const TABS = [
  { id: 'all', label: 'Tất cả', icon: LayoutGrid },
  { id: 'background', label: 'Nền', icon: Layers },
  { id: 'video', label: 'Video', icon: Video },
  { id: 'image', label: 'Hình ảnh', icon: ImageIcon },
  { id: 'voiceover', label: 'Giọng đọc', icon: Mic },
  { id: 'music', label: 'Nhạc nền', icon: Music },
  { id: 'sfx', label: 'Hiệu ứng (SFX)', icon: Volume2 },
  { id: 'text', label: 'Chữ overlay', icon: Type },
];

export default function MediaLibrary({
  projectId,
  assets = [],
  onRefresh,
  onAddClipToTimeline,
  onSetBackground,
}) {
  const [activeTab, setActiveTab] = useState('all');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [ocrModalAsset, setOcrModalAsset] = useState(null);
  const [showTtsModal, setShowTtsModal] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [previewingAudioId, setPreviewingAudioId] = useState(null);

  const fileInputRef = useRef(null);
  const abortControllerRef = useRef(null);
  const audioPreviewRef = useRef(null);

  const safeAssets = Array.isArray(assets)
    ? assets
    : (assets?.assets && Array.isArray(assets.assets) ? assets.assets : []);

  const filteredAssets = safeAssets.filter(Boolean).filter((a) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'background') return a.kind === 'background';
    if (activeTab === 'video') return a.kind === 'video';
    if (activeTab === 'image') return a.kind === 'image';
    if (activeTab === 'voiceover') return a.kind === 'voiceover';
    if (activeTab === 'music') return a.kind === 'music' || a.kind === 'bgm';
    if (activeTab === 'sfx') return a.kind === 'sfx';
    if (activeTab === 'text') return a.ocrText || a.translationText || a.kind === 'text';
    return true;
  });

  const getTabCount = (tabId) => {
    if (tabId === 'all') return safeAssets.length;
    if (tabId === 'background') return safeAssets.filter((a) => a.kind === 'background').length;
    if (tabId === 'video') return safeAssets.filter((a) => a.kind === 'video').length;
    if (tabId === 'image') return safeAssets.filter((a) => a.kind === 'image').length;
    if (tabId === 'voiceover') return safeAssets.filter((a) => a.kind === 'voiceover').length;
    if (tabId === 'music') return safeAssets.filter((a) => a.kind === 'music' || a.kind === 'bgm').length;
    if (tabId === 'sfx') return safeAssets.filter((a) => a.kind === 'sfx').length;
    if (tabId === 'text') return safeAssets.filter((a) => a.ocrText || a.translationText || a.kind === 'text').length;
    return 0;
  };

  const getAcceptType = () => {
    if (activeTab === 'image') return 'image/*';
    if (activeTab === 'background') return 'image/*,video/*';
    if (activeTab === 'video') return 'video/*';
    if (activeTab === 'voiceover' || activeTab === 'music' || activeTab === 'sfx') return 'audio/*';
    if (activeTab === 'all') return 'image/*,video/*,audio/*';
    return '*/*';
  };

  const uploadFiles = async (files) => {
    if (!files || !files.length) return;
    setErrorMessage(null);
    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;
    setUploadProgress(0);
    setUploading(true);
    try {
      const fd = new FormData();
      let uploadKind = activeTab;
      if (activeTab === 'text') {
        uploadKind = 'image';
      }
      fd.append('kind', uploadKind);
      files.forEach((f) => fd.append('files', f));
      await projectsApi.uploadAssets(projectId, fd, {
        signal: abortCtrl.signal,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const pct = Math.round((progressEvent.loaded / progressEvent.total) * 100);
            setUploadProgress(pct);
          }
        },
      });
      onRefresh?.();
    } catch (err) {
      if (
        axios.isCancel(err) ||
        err?.name === 'CanceledError' ||
        err?.code === 'ERR_CANCELED' ||
        err?.name === 'AbortError' ||
        err?.code === 'ABORT_ERR' ||
        err?.message?.toLowerCase().includes('cancel') ||
        err?.message?.toLowerCase().includes('abort')
      ) {
        return;
      }
      console.error('Upload failed:', err);
      let detailMsg = err?.response?.data?.message || err?.response?.data?.error?.message;
      if (!detailMsg) {
        if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout')) {
          detailMsg = 'Quá thời gian tải lên (Upload timeout). Vui lòng thử lại với tệp nhỏ hơn hoặc kiểm tra kết nối mạng.';
        } else if (err?.message === 'Network Error' || err?.code === 'ERR_NETWORK' || !err?.response) {
          detailMsg = 'Lỗi kết nối mạng (Network Error). Vui lòng kiểm tra backend server đang chạy tại port 3001 và cấu hình CORS/Proxy.';
        } else {
          detailMsg = err.message || 'Lỗi không xác định khi tải tệp';
        }
      }
      setErrorMessage(detailMsg);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      abortControllerRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    await uploadFiles(files);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
      await uploadFiles(files);
    }
  };

  const handleCancelUpload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDeleteAsset = async (assetId) => {
    if (!window.confirm('Bạn có chắc muốn xóa tư liệu này khỏi dự án?')) return;
    try {
      if (previewingAudioId === assetId && audioPreviewRef.current) {
        audioPreviewRef.current.pause();
        setPreviewingAudioId(null);
      }
      await projectsApi.deleteAsset(projectId, assetId);
      onRefresh?.();
    } catch (err) {
      setErrorMessage('Xóa tệp thất bại: ' + (err?.response?.data?.message || err.message));
    }
  };

  const handleMoveAsset = async (assetId, direction) => {
    const list = [...filteredAssets];
    const index = list.findIndex((a) => a.id === assetId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;

    // Swap within filtered list, then rebuild full order preserving non-filtered positions
    const swappedA = list[index];
    const swappedB = list[targetIndex];
    const fullOrder = safeAssets.map((a) => {
      if (a.id === swappedA.id) return swappedB;
      if (a.id === swappedB.id) return swappedA;
      return a;
    });

    const newOrderIds = fullOrder.map((a) => a.id);
    try {
      await projectsApi.reorderAssets(projectId, newOrderIds);
      onRefresh?.();
    } catch (err) {
      console.warn('Reorder failed:', err);
    }
  };

  const handleToggleAudioPreview = (asset) => {
    if (!audioPreviewRef.current) return;
    if (previewingAudioId === asset.id) {
      audioPreviewRef.current.pause();
      setPreviewingAudioId(null);
    } else {
      audioPreviewRef.current.src = asset.url;
      audioPreviewRef.current.play()
        .then(() => setPreviewingAudioId(asset.id))
        .catch(() => setPreviewingAudioId(null));
    }
  };

  // Stop audio preview on unmount
  useEffect(() => {
    return () => {
      if (audioPreviewRef.current) {
        try {
          audioPreviewRef.current.pause();
          audioPreviewRef.current.src = '';
        } catch (_) {}
      }
    };
  }, []);

  const handleOcrOverlayAdded = ({ assetId, text, style }) => {
    onAddClipToTimeline?.({
      trackType: 'text',
      assetId,
      textContent: text,
      content: text,
      duration: 4,
      style: style || { fontSize: 28, color: '#FFFFFF', bg: 'rgba(0,0,0,0.65)', position: 'bottom' },
    });
    onRefresh?.();
  };

  const handleTtsVoiceoverAdded = (ttsRes) => {
    onAddClipToTimeline?.({
      trackType: 'voiceover',
      audioId: ttsRes.audioId,
      assetId: ttsRes.audioId,
      duration: ttsRes.durationSec,
      content: ttsRes.text || 'Giọng đọc AI',
      meta: { text: ttsRes.text },
    });
    onRefresh?.();
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex flex-col h-full bg-card border-r border-border select-none"
    >
      <audio
        ref={audioPreviewRef}
        onEnded={() => setPreviewingAudioId(null)}
        onPause={() => setPreviewingAudioId(null)}
        className="hidden"
      />

      {/* Drag & Drop Visual Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-30 bg-primary/20 backdrop-blur-xs border-2 border-dashed border-primary flex flex-col items-center justify-center p-6 text-center pointer-events-none transition-all">
          <Upload className="w-12 h-12 text-primary animate-bounce mb-2" />
          <h4 className="text-sm font-bold text-foreground">Thả tệp vào đây để tải lên</h4>
          <p className="text-xs text-muted-foreground mt-1">Hỗ trợ hình ảnh, video và âm thanh (MP4, MP3, PNG, JPG)</p>
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex items-center gap-1 p-2 border-b border-border bg-muted/30 overflow-x-auto scrollbar-thin">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const count = getTabCount(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                isActive
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
              {count > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    isActive ? 'bg-primary-foreground/20 text-primary-foreground font-bold' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Action Bar (Upload & Tool buttons) */}
      <div className="p-3 border-b border-border flex items-center justify-between gap-2 bg-muted/10">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={getAcceptType()}
          onChange={handleFilesSelected}
          className="hidden"
        />

        {activeTab !== 'text' && (
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border hover:border-primary/50 bg-background hover:bg-muted text-xs font-semibold text-foreground transition disabled:opacity-50 cursor-pointer shadow-2xs"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> : <Upload className="w-3.5 h-3.5 text-primary" />}
            <span>
              {uploading
                ? `Đang tải lên (${uploadProgress}%)...`
                : activeTab === 'all'
                ? 'Thêm tài nguyên'
                : `Thêm ${TABS.find((t) => t.id === activeTab)?.label}`}
            </span>
          </button>
        )}

        {(activeTab === 'voiceover' || activeTab === 'all') && (
          <button
            type="button"
            onClick={() => setShowTtsModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-semibold transition cursor-pointer shadow-2xs"
          >
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <span>Sinh TTS</span>
          </button>
        )}
      </div>

      {/* Inline Error Message Banner */}
      {errorMessage && (
        <div className="p-2.5 mx-3 mt-2 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-start justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="truncate">{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="p-0.5 hover:bg-destructive/20 rounded text-destructive shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Upload Progress Bar & Cancel Button */}
      {uploading && (
        <div className="p-2.5 mx-3 mt-2 rounded-xl bg-card border border-border flex flex-col gap-1.5 shadow-xs">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              Đang tải lên... {uploadProgress}%
            </span>
            <button
              type="button"
              onClick={handleCancelUpload}
              className="text-[11px] font-semibold text-destructive hover:underline cursor-pointer"
            >
              Hủy
            </button>
          </div>
          <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-primary h-full transition-all duration-150 rounded-full"
              style={{ width: `${Math.max(5, uploadProgress)}%` }}
            />
          </div>
        </div>
      )}

      {/* Asset Items List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filteredAssets.length === 0 ? (
          <div className="h-56 flex flex-col items-center justify-center text-center p-6 rounded-xl border border-dashed border-border/60 bg-muted/5 text-muted-foreground">
            <Upload className="w-10 h-10 stroke-1 mb-3 opacity-40 text-primary" />
            <span className="text-sm font-semibold text-foreground">Chưa có tư liệu trong mục này</span>
            <p className="text-xs opacity-75 mt-1 max-w-[220px]">
              Kéo thả tệp vào đây hoặc nhấn thêm để bắt đầu biên tập trên dòng thời gian
            </p>
            {activeTab !== 'text' && (
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition shadow-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Thêm tài nguyên</span>
              </button>
            )}
          </div>
        ) : (
          filteredAssets.map((asset, index) => {
            const isVideoAsset = Boolean(
              asset.kind === 'video' ||
              (asset.kind === 'background' &&
                (asset.mimeType?.startsWith('video/') ||
                  asset.mime_type?.startsWith('video/') ||
                  /\.(mp4|webm|mov|mkv)$/i.test(asset.storageKey || asset.storage_key || ''))) ||
              asset.mimeType?.startsWith('video/') ||
              asset.mime_type?.startsWith('video/')
            );
            const isBgAsset = asset.kind === 'background';
            const isAudioAsset = Boolean(
              asset.kind === 'voiceover' ||
              asset.kind === 'music' ||
              asset.kind === 'bgm' ||
              asset.kind === 'sfx' ||
              asset.mimeType?.startsWith('audio/') ||
              asset.mime_type?.startsWith('audio/')
            );
            const isPreviewingThisAudio = previewingAudioId === asset.id;

            return (
              <div
                key={asset.id}
                className="group flex items-center gap-3 p-2 rounded-xl border border-border bg-muted/20 hover:bg-muted/50 transition-all text-left"
              >
                {/* Thumbnail / Icon */}
                {asset.kind === 'image' || isBgAsset || isVideoAsset ? (
                  <div className="w-14 h-14 rounded-lg bg-black/20 border border-border overflow-hidden shrink-0 relative flex items-center justify-center">
                    {asset.thumbnailUrl || (asset.kind === 'image' && asset.url) ? (
                      <img
                        src={asset.thumbnailUrl || asset.url}
                        alt={asset.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <Video className="w-6 h-6 text-blue-400" />
                    )}
                    {isVideoAsset && (
                      <span className="absolute top-0.5 left-0.5 text-[8px] bg-blue-600/90 text-white px-1 rounded font-bold tracking-wide">
                        VIDEO
                      </span>
                    )}
                    {!isVideoAsset && isBgAsset && (
                      <span className="absolute top-0.5 left-0.5 text-[8px] bg-purple-600/90 text-white px-1 rounded font-bold tracking-wide">
                        NỀN
                      </span>
                    )}
                    {asset.ocrText && (
                      <span className="absolute bottom-0.5 right-0.5 text-[8px] bg-emerald-600/90 text-white px-1 rounded font-bold">
                        OCR
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 text-primary relative">
                    {isAudioAsset && asset.url ? (
                      <button
                        type="button"
                        title={isPreviewingThisAudio ? 'Dừng nghe thử' : 'Nghe thử âm thanh'}
                        onClick={() => handleToggleAudioPreview(asset)}
                        className={`w-8 h-8 rounded-full flex items-center justify-center transition cursor-pointer ${
                          isPreviewingThisAudio
                            ? 'bg-primary text-primary-foreground shadow-sm animate-pulse'
                            : 'bg-background hover:bg-primary/20 text-primary'
                        }`}
                      >
                        {isPreviewingThisAudio ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                      </button>
                    ) : asset.kind === 'voiceover' ? (
                      <Mic className="w-5 h-5" />
                    ) : asset.kind === 'sfx' ? (
                      <Volume2 className="w-5 h-5" />
                    ) : (
                      <FileAudio className="w-5 h-5" />
                    )}
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-semibold text-foreground truncate block">{asset.name}</span>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                    {asset.durationSec ? (
                      <span className="font-mono">{Number(asset.durationSec).toFixed(1)}s</span>
                    ) : asset.byteSize ? (
                      <span className="font-mono">{Math.round(asset.byteSize / 1024)} KB</span>
                    ) : null}
                    {asset.translationText && (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">Đã dịch</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-90 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                  {filteredAssets.length > 1 && (
                    <div className="flex flex-col gap-0.5 mr-0.5">
                      <button
                        type="button"
                        title="Di chuyển lên trước"
                        disabled={index === 0}
                        onClick={() => handleMoveAsset(asset.id, 'up')}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-20 transition cursor-pointer"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title="Di chuyển xuống sau"
                        disabled={index === filteredAssets.length - 1}
                        onClick={() => handleMoveAsset(asset.id, 'down')}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-20 transition cursor-pointer"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  {asset.kind === 'image' && (
                    <button
                      type="button"
                      title="OCR & Dịch chữ trên ảnh"
                      onClick={() => setOcrModalAsset(asset)}
                      className="p-1.5 rounded-lg border border-border bg-background hover:bg-muted text-foreground transition cursor-pointer"
                    >
                      <ScanText className="w-3.5 h-3.5 text-primary" />
                    </button>
                  )}

                  {(isBgAsset || isVideoAsset || asset.kind === 'image') && onSetBackground && (
                    <button
                      type="button"
                      title="Đặt làm nền dự án"
                      onClick={() => onSetBackground(asset)}
                      className="p-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 text-purple-600 dark:text-purple-400 transition cursor-pointer"
                    >
                      <Layers className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    type="button"
                    title="Thêm clip vào timeline"
                    onClick={() => {
                      let trackType = asset.kind;
                      if (trackType === 'bgm') trackType = 'music';
                      if (trackType === 'background') trackType = 'background';
                      onAddClipToTimeline?.({
                        trackType: trackType || (isVideoAsset ? 'video' : 'image'),
                        assetId: asset.id,
                        duration: asset.durationSec || 4,
                        content: asset.name,
                        textContent: asset.ocrText || asset.translationText || '',
                      });
                    }}
                    className="p-1.5 rounded-lg border border-border bg-background hover:bg-muted text-foreground transition cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  </button>

                  <button
                    type="button"
                    title="Xóa tư liệu"
                    onClick={() => handleDeleteAsset(asset.id)}
                    className="p-1.5 rounded-lg border border-border bg-background hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* OCR & Translation Modal */}
      {ocrModalAsset && (
        <OcrTranslateModal
          isOpen={!!ocrModalAsset}
          onClose={() => setOcrModalAsset(null)}
          asset={ocrModalAsset}
          projectId={projectId}
          onAddOverlay={handleOcrOverlayAdded}
        />
      )}

      {/* TTS Modal */}
      {showTtsModal && (
        <TtsModal
          isOpen={showTtsModal}
          onClose={() => setShowTtsModal(false)}
          projectId={projectId}
          onAddVoiceover={handleTtsVoiceoverAdded}
        />
      )}
    </div>
  );
}
