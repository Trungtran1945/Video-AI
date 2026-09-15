import { motion } from 'framer-motion';

export default function StatCard({ icon: Icon, label, value, sublabel, color = 'blue', delay = 0 }) {
  const colorStyles = {
    blue: {
      badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
      glow: 'from-blue-500/10 to-transparent',
    },
    green: {
      badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
      glow: 'from-emerald-500/10 to-transparent',
    },
    purple: {
      badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
      glow: 'from-violet-500/10 to-transparent',
    },
    orange: {
      badge: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
      glow: 'from-orange-500/10 to-transparent',
    },
    red: {
      badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
      glow: 'from-rose-500/10 to-transparent',
    },
    cyan: {
      badge: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
      glow: 'from-cyan-500/10 to-transparent',
    },
  };

  const scheme = colorStyles[color] || colorStyles.blue;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="relative rounded-2xl bg-card border border-border p-5 overflow-hidden group hover:border-primary/30 hover:shadow-md transition-all"
    >
      <div
        className={`absolute inset-0 bg-gradient-to-br ${scheme.glow} opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none`}
      />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${scheme.badge}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
        <div className="text-2xl font-bold text-foreground tracking-tight">{value}</div>
        <div className="text-sm text-muted-foreground mt-1 font-medium">{label}</div>
        {sublabel && <div className="text-xs text-muted-foreground/80 mt-1">{sublabel}</div>}
      </div>
    </motion.div>
  );
}