import OptionCard from './OptionCard';
import { VOICE_PROVIDER_LABELS } from '@/lib/constants';

export const SAMPLE_VOICES = {
  voicestudio: [
    { id: 'default', label: 'Default (Chuẩn)' },
    { id: 'alloy', label: 'Alloy (Cân bằng)' },
    { id: 'echo', label: 'Echo (Ấm áp)' },
    { id: 'fable', label: 'Fable (Diễn cảm)' },
    { id: 'onyx', label: 'Onyx (Trầm ấm)' },
    { id: 'nova', label: 'Nova (Trẻ trung)' },
    { id: 'shimmer', label: 'Shimmer (Rõ ràng)' },
  ],
  edge_tts: [
    { id: 'vi-VN-HoaiMyNeural', label: 'Hoài My (Nữ)' },
    { id: 'vi-VN-NamMinhNeural', label: 'Nam Minh (Nam)' },
  ],
  elevenlabs: [
    { id: 'Rachel', label: 'Rachel' },
    { id: 'Adam', label: 'Adam' },
    { id: 'Josh', label: 'Josh' },
  ],
};

export default function VoiceStep({ form, update, optional }) {
  const currentSamples = SAMPLE_VOICES[form.voiceProvider] || [];

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs sm:text-sm font-semibold text-foreground mb-2 block">
          {optional ? 'Giọng đọc (tuỳ chọn)' : 'Nhà cung cấp giọng đọc AI'}
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(VOICE_PROVIDER_LABELS).map(([code, label]) => (
            <OptionCard
              key={code}
              selected={form.voiceProvider === code}
              onClick={() => update('voiceProvider', code)}
              title={label}
            />
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs sm:text-sm font-semibold text-foreground">Tên giọng / Voice ID (tuỳ chọn)</label>
          {form.voiceProvider === 'voicestudio' && (
            <span className="text-[11px] text-muted-foreground font-mono">VoiceStudio: http://localhost:3900</span>
          )}
        </div>
        <input
          value={form.voiceName}
          onChange={(e) => update('voiceName', e.target.value)}
          placeholder={form.voiceProvider === 'voicestudio' ? 'VD: default, alloy, echo, onyx...' : 'VD: Rachel, Adam, Josh...'}
          className="w-full px-3.5 py-2 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />

        {currentSamples.length > 0 && (
          <div className="mt-2.5">
            <span className="text-xs text-muted-foreground block mb-1.5">Giọng mẫu khả dụng:</span>
            <div className="flex flex-wrap gap-1.5">
              {currentSamples.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => update('voiceName', v.id)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-all ${
                    form.voiceName === v.id
                      ? 'bg-primary text-primary-foreground border-primary font-medium shadow-xs'
                      : 'bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border-border'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
