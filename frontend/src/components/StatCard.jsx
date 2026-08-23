import { motion } from 'framer-motion';

export default function StatCard({ icon: Icon, label, value, sublabel, color = 'blue', delay = 0 }) {
  const colorMap = {
    blue: 'from-blue-500/20 to-blue-500/5 text-blue-400',
    green: 'from-emerald-500/20 to-emerald-500/5 text-emerald-400',
    purple: 'from-violet-500/20 to-violet-500/5 text-violet-400',
    orange: 'from-orange-500/20 to-orange-500/5 text-orange-400',
    red: 'from-red-500/20 to-red-500/5 text-red-400',
    cyan: 'from-cyan-500/20 to-cyan-500/5 text-cyan-400',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="relative rounded-2xl bg-[#161922] border border-white/5 p-5 overflow-hidden group hover:border-white/10 transition-colors"
    >
      <div className={`absolute inset-0 bg-gradient-to-br ${colorMap[color]} opacity-0 group-hover:opacity-100 transition-opacity`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${colorMap[color]} flex items-center justify-center`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
        <div className="text-2xl font-bold text-white tracking-tight">{value}</div>
        <div className="text-sm text-slate-400 mt-0.5">{label}</div>
        {sublabel && <div className="text-xs text-slate-500 mt-1">{sublabel}</div>}
      </div>
    </motion.div>
  );
}