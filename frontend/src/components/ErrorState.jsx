import { AlertTriangle, Lock, SearchX } from 'lucide-react';

const STATUS_COPY = {
  403: { icon: Lock, title: 'Thiếu quyền truy cập', description: 'Tài khoản của bạn không có quyền xem nội dung này.' },
  404: { icon: SearchX, title: 'Không tìm thấy', description: 'Nội dung yêu cầu không tồn tại hoặc đã bị xoá.' },
};

export default function ErrorState({ status = 0, message, onRetry, className = '' }) {
  const preset = STATUS_COPY[Number(status)] || null;
  const Icon = preset?.icon || AlertTriangle;
  const title = preset?.title || 'Không tải được dữ liệu';
  const description = message || preset?.description || 'Đã xảy ra lỗi khi tải dữ liệu. Kiểm tra kết nối mạng rồi thử lại.';
  return (
    <div className={`flex flex-col items-center justify-center py-12 sm:py-16 px-4 text-center rounded-2xl border border-destructive/25 bg-destructive/5 ${className}`}>
      <div className="w-12 h-12 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-3.5 text-destructive shadow-xs">
        <Icon className="w-6 h-6" />
      </div>
      <h3 className="text-sm sm:text-base font-semibold text-foreground tracking-tight">{title}</h3>
      <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 max-w-md leading-relaxed">
        {description}
        {Number(status) > 0 && <span className="font-mono"> (HTTP {Number(status)})</span>}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs sm:text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Thử lại
        </button>
      )}
    </div>
  );
}
