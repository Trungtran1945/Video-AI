import { motion } from 'framer-motion';

export default function StatCard({ icon: Icon, label, value, sublabel, delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.2 }}
      className="rounded-xl bg-card border border-border p-4 sm:p-5 hover:border-border/80 hover:shadow-xs transition-all flex flex-col justify-between"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="text-xs sm:text-sm font-medium text-muted-foreground">{label}</span>
        {Icon && (
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-muted-foreground shrink-0">
            <Icon className="w-4 h-4" />
          </div>
        )}
      </div>
      <div>
        <div className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground tabular-nums">
          {value}
        </div>
        {sublabel && (
          <div className="text-xs text-muted-foreground/80 mt-1 font-medium">{sublabel}</div>
        )}
      </div>
    </motion.div>
  );
}