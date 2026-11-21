import { Inbox } from 'lucide-react';

export default function EmptyState({ icon: Icon = Inbox, title, description, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 sm:py-16 px-4 text-center rounded-xl border border-dashed border-border bg-card/40 ${className}`}>
      <div className="w-10 h-10 rounded-lg bg-secondary border border-border/80 flex items-center justify-center mb-3 text-muted-foreground">
        <Icon className="w-5 h-5" />
      </div>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-md leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}