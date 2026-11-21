import { Check } from 'lucide-react';

export default function OptionCard({ selected, onClick, title, desc, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-3.5 rounded-lg border transition-colors w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        selected
          ? 'border-primary bg-primary/10 text-foreground font-semibold shadow-xs'
          : 'border-border bg-card hover:bg-muted/40 hover:border-border/90'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs sm:text-sm font-semibold text-foreground">{title}</div>
          {desc && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed font-normal">{desc}</div>}
        </div>
        {selected && <Check className="w-4 h-4 text-primary shrink-0 ml-2" />}
      </div>
      {children}
    </button>
  );
}
