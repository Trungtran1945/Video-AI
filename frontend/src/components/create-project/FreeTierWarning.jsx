import { AlertTriangle } from 'lucide-react';

export default function FreeTierWarning({ mode, estimatedDuration }) {
  const thresholds = { SUMMARY: 60 * 60, TRANSLATE_DUB: 20 * 60 };
  const threshold = thresholds[mode];
  if (!threshold || !estimatedDuration || estimatedDuration <= threshold) return null;

  return (
    <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4 text-left">
      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm text-amber-800 dark:text-amber-300 font-semibold">Cảnh báo hạn mức miễn phí (Free Tier)</p>
        <p className="text-xs text-amber-700/80 dark:text-amber-300/70 mt-1 leading-relaxed">
          Với API key miễn phí, xử lý nội dung dài có thể chậm hơn nhiều do giới hạn tốc độ của nhà cung cấp.
          Khuyến nghị thử nghiệm với clip ngắn (≤ 10 phút) trước.
        </p>
      </div>
    </div>
  );
}
