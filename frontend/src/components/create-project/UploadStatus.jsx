// R1: tiến trình upload + nút Hủy (giữa chừng) / Thử lại (resume cùng session).
export default function UploadStatus({ uploading, uploadPercent, canRetry, onCancel, onRetry }) {
  if (!uploading && !canRetry) return null;
  return (
    <div className="space-y-1.5">
      {uploading && (
        <>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">{uploadPercent}% — rớt mạng sẽ tự tiếp tục</p>
            <button
              type="button"
              onClick={onCancel}
              className="text-xs font-semibold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
            >
              Hủy tải lên
            </button>
          </div>
        </>
      )}
      {!uploading && canRetry && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>Thử lại (tiếp tục từ chỗ đã dừng)</span>
          </button>
        </div>
      )}
    </div>
  );
}
