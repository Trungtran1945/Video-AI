import { Loader2 } from 'lucide-react';

export default function Loading({ text = 'Đang tải...' }) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      <p className="text-sm text-slate-400 mt-3">{text}</p>
    </div>
  );
}