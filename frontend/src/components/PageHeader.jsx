import { motion } from 'framer-motion';

export default function PageHeader({ title, subtitle, action, badge }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/40"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-bold text-foreground tracking-tight">{title}</h1>
          {badge}
        </div>
        {subtitle && (
          <p className="text-xs sm:text-sm text-muted-foreground mt-1 leading-relaxed max-w-2xl">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-center">{action}</div>}
    </motion.div>
  );
}