import { Check, ChevronRight } from 'lucide-react';

export default function StepIndicator({ steps, step }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-6 sm:mb-8 overflow-x-auto pb-2">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1 shrink-0">
          <div
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              i === step
                ? 'bg-primary text-primary-foreground shadow-xs'
                : i < step
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < step ? <Check className="w-3.5 h-3.5" /> : <s.icon className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{s.label}</span>
          </div>
          {i < steps.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground/40" />}
        </div>
      ))}
    </div>
  );
}
