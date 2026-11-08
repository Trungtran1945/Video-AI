import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Play, Pause, Loader2, Plus, X, AlertCircle, Volume2 } from 'lucide-react';
import { projectsApi } from '@/api/projects';

const SAMPLE_VOICES = {
  edge_tts: [
    { id: 'vi-VN-HoaiMyNeural', label: 'Hoài My (Nữ - Truyền cảm)' },
    { id: 'vi-VN-NamMinhNeural', label: 'Nam Minh (Nam - Trầm ấm)' },
  ],
  elevenlabs: [
    { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel (Nữ)' },
    { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi (Nữ mạnh mẽ)' },
  ],
  voicestudio: [
    { id: 'vietnamese_female', label: 'Nữ Việt Nam (Local)' },
    { id: 'vietnamese_male', label: 'Nam Việt Nam (Local)' },
  ],
  google_tts: [
    { id: '', label: 'Tiếng Việt mặc định' },
  ],
};

export default function TtsModal({ isOpen, onClose, projectId, onAddVoiceover }) {
  const [text, setText] = useState('');
  const [provider, setProvider] = useState('edge_tts');
  const [voiceId, setVoiceId] = useState('vi-VN-HoaiMyNeural');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [generatedAudio, setGeneratedAudio] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = React.useRef(null);

  const handleProviderChange = (p) => {
    setProvider(p);
    const list = SAMPLE_VOICES[p] || [];
    setVoiceId(list[0]?.id || '');
  };

  const handleGenerate = async () => {
    if (!text.trim()) return;
    setGenerating(true);
    setError('');
    try {
      const res = await projectsApi.generateTts(projectId, {
        text: text.trim(),
        voiceProvider: provider,
        voiceId: voiceId || undefined,
      });
      setGeneratedAudio(res);
    } catch (err) {
      setError(err?.response?.data?.message || 'Không thể tạo giọng đọc AI');
    } finally {
      setGenerating(false);
    }
  };

  const handleTogglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const handleAddToTimeline = () => {
    if (!generatedAudio) return;
    onAddVoiceover?.({
      ...generatedAudio,
      text: text.trim(),
    });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="w-full max-w-lg rounded-2xl bg-card border border-border shadow-2xl overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="px-5 py-4 border-b border-border flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                <Mic className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Sinh Giọng Đọc AI (Voiceover)</h3>
                <p className="text-xs text-muted-foreground">Tạo file âm thanh lời bình từ văn bản</p>
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

          {/* Body */}
          <div className="p-5 space-y-4 text-left">
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-xs text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">
                Nội dung lời bình (Văn bản):
              </label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Nhập câu nói, đoạn văn thuyết minh hoặc kịch bản cần đọc..."
                rows={4}
                className="w-full px-3 py-2 text-xs rounded-xl bg-background border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-foreground"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-foreground mb-1.5 block">
                  Nhà cung cấp giọng đọc:
                </label>
                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-medium focus:outline-none"
                >
                  <option value="edge_tts">Edge-TTS (Miễn phí)</option>
                  <option value="elevenlabs">ElevenLabs (Cao cấp)</option>
                  <option value="voicestudio">VoiceStudio (Local)</option>
                  <option value="google_tts">Google TTS</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground mb-1.5 block">
                  Giọng đọc:
                </label>
                <select
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-background border border-border text-foreground font-medium focus:outline-none"
                >
                  {(SAMPLE_VOICES[provider] || []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Generated Audio Preview */}
            {generatedAudio && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleTogglePlay}
                    className="w-8 h-8 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center transition"
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </button>
                  <div>
                    <span className="text-xs font-semibold text-foreground block">Đã tạo âm thanh AI</span>
                    <span className="text-[11px] text-muted-foreground font-mono">
                      Thời lượng: {generatedAudio.durationSec?.toFixed(1)}s
                    </span>
                  </div>
                </div>
                <audio
                  ref={audioRef}
                  src={generatedAudio.url}
                  onEnded={() => setIsPlaying(false)}
                  onPause={() => setIsPlaying(false)}
                  className="hidden"
                />
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border flex items-center justify-between bg-muted/20">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || !text.trim()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-medium text-foreground transition disabled:opacity-50"
            >
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5 text-primary" />}
              <span>{generating ? 'Đang tạo âm thanh...' : 'Tạo âm thanh AI'}</span>
            </button>

            <button
              type="button"
              onClick={handleAddToTimeline}
              disabled={!generatedAudio}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition disabled:opacity-50 shadow-xs"
            >
              <Plus className="w-4 h-4" />
              <span>Thêm vào Voiceover</span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
