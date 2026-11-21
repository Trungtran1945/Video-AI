import { Upload, Loader2 } from 'lucide-react';

export default function UploadBlock({ label, fileName, onChange, accept, multiple, uploading, hint }) {
  return (
    <div>
      <label className="text-xs sm:text-sm font-semibold text-foreground mb-2 block">{label}</label>
      <label
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-8 sm:py-10 transition-colors ${
          uploading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
        } ${
          fileName
            ? 'border-primary/50 bg-primary/5'
            : 'border-border hover:border-border/90 bg-muted/20'
        }`}
      >
        <Upload className="w-7 h-7 text-primary/70" />
        <span className="text-xs sm:text-sm font-semibold text-foreground text-center px-4">{fileName || 'Nhấn hoặc kéo thả tệp video vào đây'}</span>
        {hint && <span className="text-xs text-muted-foreground text-center px-4">{hint}</span>}
        {uploading && <Loader2 className="w-5 h-5 animate-spin text-primary mt-2" />}
        <input type="file" accept={accept} multiple={multiple} onChange={onChange} className="hidden" />
      </label>
    </div>
  );
}
