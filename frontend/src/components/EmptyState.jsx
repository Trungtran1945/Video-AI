import { Inbox } from 'lucide-react';

export default function EmptyState({ icon: Icon = Inbox, title, description, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 sm:py-16 px-4 text-center rounded-2xl border border-dashed border-border/80 bg-muted/15 ${className}`}>
      <div className="w-12 h-12 rounded-xl bg-muted border border-border/60 flex items-center justify-center mb-3.5 text-muted-foreground shadow-xs">
        <Icon className="w-6 h-6" />
      </div>
      <h3 className="text-sm sm:text-base font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 max-w-md leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}