import { motion } from 'framer-motion';

export default function StatCard({ icon: Icon, label, value, sublabel, delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.15 }}
      className="rounded-xl bg-card border border-border p-4 sm:p-5 flex flex-col justify-between"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="text-xs sm:text-sm font-medium text-muted-foreground">{label}</span>
        {Icon && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-secondary text-muted-foreground border border-border/50">
            <Icon className="w-4 h-4" />
          </div>
        )}
      </div>
      <div>
        <div className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground tabular-nums">
          {value}
        </div>
        {sublabel && (
          <div className="text-xs text-muted-foreground mt-1.5 font-normal">{sublabel}</div>
        )}
      </div>
    </motion.div>
  );
}