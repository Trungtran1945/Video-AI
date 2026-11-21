export default function ModeCard({ onClick, icon: Icon, title, desc }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left p-5 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-secondary/40 transition-colors group shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="w-9 h-9 rounded-lg bg-secondary text-primary border border-border/80 flex items-center justify-center mb-3">
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">{title}</div>
      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{desc}</p>
    </button>
  );
}
