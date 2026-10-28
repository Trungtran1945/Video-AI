import { motion } from 'framer-motion';

const COLOR_STYLES = {
  blue: 'bg-primary/10 text-primary',
  purple: 'bg-purple-500/10 text-purple-600 dark:text-purple-300',
  orange: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
  green: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',
};

export default function StatCard({ icon: Icon, label, value, sublabel, delay = 0, color }) {
  const iconTone = (color && COLOR_STYLES[color]) || 'bg-muted text-muted-foreground';
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
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconTone}`}>
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