import React, { useState, useRef } from 'react';
import {
  Layers,
  Image as ImageIcon,
  Mic,
  Music,
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
} from 'lucide-react';
import { projectsApi } from '@/api/projects';
import OcrTranslateModal from './OcrTranslateModal';
import TtsModal from './TtsModal';

const TABS = [
  { id: 'image', label: 'Hình ảnh', icon: ImageIcon },
  { id: 'background', label: 'Nền', icon: Layers },
  { id: 'voiceover', label: 'Giọng đọc', icon: Mic },
  { id: 'music', label: 'Nhạc nền', icon: Music },
  { id: 'text', label: 'Chữ overlay', icon: Type },
];

export default function MediaLibrary({
  projectId,
  assets = [],
  onRefresh,
  onAddClipToTimeline,
}) {
  const [activeTab, setActiveTab] = useState('image');
  const [uploading, setUploading] = useState(false);
  const [ocrModalAsset, setOcrModalAsset] = useState(null);
  const [showTtsModal, setShowTtsModal] = useState(false);
  const fileInputRef = useRef(null);

  const filteredAssets = assets.filter((a) => {
    if (activeTab === 'image') return a.kind === 'image';
    if (activeTab === 'background') return a.kind === 'background';
    if (activeTab === 'voiceover') return a.kind === 'voiceover';
    if (activeTab === 'music') return a.kind === 'music' || a.kind === 'bgm' || a.kind === 'sfx';
    if (activeTab === 'text') return a.ocrText || a.translationText;
    return true;
  });

  const getAcceptType = () => {
    if (activeTab === 'image' || activeTab === 'background') return 'image/*,video/*';
    if (activeTab === 'voiceover' || activeTab === 'music') return 'audio/*';
    return '*/*';
  };

  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('kind', activeTab === 'text' ? 'image' : activeTab);
      files.forEach((f) => fd.append('files', f));
      await projectsApi.uploadAssets(projectId, fd);
      onRefresh?.();
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Tải tệp lên thất bại: ' + (err?.response?.data?.message || err.message));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteAsset = async (assetId) => {
    if (!window.confirm('Bạn có chắc muốn xóa tư liệu này?')) return;
    try {
      await projectsApi.deleteAsset(projectId, assetId);
      onRefresh?.();
    } catch (err) {
      alert('Xóa tệp thất bại: ' + (err?.response?.data?.message || err.message));
    }
  };

  const handleMoveAsset = async (assetId, direction) => {
    const list = [...filteredAssets];
    const index = list.findIndex((a) => a.id === assetId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;

    const temp = list[index];
    list[index] = list[targetIndex];
    list[targetIndex] = temp;

    const newOrderIds = list.map((a) => a.id);
    try {
      await projectsApi.reorderAssets(projectId, newOrderIds);
      onRefresh?.();
    } catch (err) {
      console.warn('Reorder failed:', err);
    }
  };

  const handleOcrOverlayAdded = ({ assetId, text }) => {
    onAddClipToTimeline?.({
      trackType: 'text',
      assetId,
      textContent: text,
      duration: 4,
    });
    onRefresh?.();
  };

  const handleTtsVoiceoverAdded = (ttsRes) => {
    onAddClipToTimeline?.({
      trackType: 'voiceover',
      audioId: ttsRes.audioId,
      assetId: ttsRes.audioId,
      duration: ttsRes.durationSec,
      meta: { text: ttsRes.text },
    });
    onRefresh?.();
  };

  return (
    <div className="flex flex-col h-full bg-card border-r border-border select-none">
      {/* Category Tabs */}
      <div className="flex items-center gap-1 p-2 border-b border-border bg-muted/30 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                isActive
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
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
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border hover:border-primary/50 bg-background hover:bg-muted text-xs font-semibold text-foreground transition disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> : <Upload className="w-3.5 h-3.5 text-primary" />}
            <span>{uploading ? 'Đang tải lên...' : `Thêm ${TABS.find((t) => t.id === activeTab)?.label}`}</span>
          </button>
        )}

        {activeTab === 'voiceover' && (
          <button
            type="button"
            onClick={() => setShowTtsModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-semibold transition"
          >
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <span>Sinh TTS AI</span>
          </button>
        )}
      </div>

      {/* Asset Items List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filteredAssets.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4 rounded-xl border border-dashed border-border/60 text-muted-foreground">
            <Upload className="w-8 h-8 stroke-1 mb-2 opacity-50" />
            <span className="text-xs font-medium">Chưa có tư liệu trong mục này</span>
            <p className="text-[11px] opacity-75 mt-0.5">Bấm nút &quot;Thêm&quot; ở trên để tải file vào dự án</p>
          </div>
        ) : (
          filteredAssets.map((asset, index) => (
            <div
              key={asset.id}
              className="group flex items-center gap-3 p-2 rounded-xl border border-border bg-muted/20 hover:bg-muted/50 transition-all text-left"
            >
              {/* Thumbnail / Icon */}
              {asset.kind === 'image' || asset.kind === 'background' ? (
                <div className="w-14 h-14 rounded-lg bg-black/20 border border-border overflow-hidden shrink-0 relative">
                  <img
                    src={asset.thumbnailUrl || asset.url}
                    alt={asset.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  {asset.ocrText && (
                    <span className="absolute bottom-0.5 right-0.5 text-[8px] bg-emerald-600/90 text-white px-1 rounded font-bold">
                      OCR
                    </span>
                  )}
                </div>
              ) : (
                <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 text-primary">
                  {asset.kind === 'voiceover' ? <Mic className="w-5 h-5" /> : <FileAudio className="w-5 h-5" />}
                </div>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-foreground truncate block">{asset.name}</span>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                  {asset.durationSec ? (
                    <span className="font-mono">{asset.durationSec.toFixed(1)}s</span>
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
                {activeTab === 'image' && (
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
                    className="p-1.5 rounded-lg border border-border bg-background hover:bg-muted text-foreground transition"
                  >
                    <ScanText className="w-3.5 h-3.5 text-primary" />
                  </button>
                )}

                <button
                  type="button"
                  title="Thêm clip vào timeline"
                  onClick={() =>
                    onAddClipToTimeline?.({
                      trackType: asset.kind,
                      assetId: asset.id,
                      duration: asset.durationSec || 4,
                    })
                  }
                  className="p-1.5 rounded-lg border border-border bg-background hover:bg-muted text-foreground transition"
                >
                  <Plus className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                </button>

                <button
                  type="button"
                  title="Xóa tư liệu"
                  onClick={() => handleDeleteAsset(asset.id)}
                  className="p-1.5 rounded-lg border border-border bg-background hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
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
