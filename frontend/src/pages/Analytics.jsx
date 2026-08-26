import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import { logsApi, queueApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { BarChart3, Video, CheckCircle, XCircle, TrendingUp, Layers } from 'lucide-react';
import { STATUS_LABELS } from '@/lib/constants';

export default function Analytics() {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [p, j, l] = await Promise.all([
          projectsApi.list(),
          queueApi.list(),
          logsApi.list(100),
        ]);
        setProjects(p || []); setJobs(j || []); setLogs(l || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <Layout><Loading /></Layout>;

  const totalProjects = projects.length;
  const completed = projects.filter(p => p.status === 'completed').length;
  const failed = projects.filter(p => p.status === 'failed').length;
  const successRate = totalProjects > 0 ? Math.round((completed / totalProjects) * 100) : 0;
  const totalTokens = logs.reduce((s, l) => s + ((l.tokens_in || 0) + (l.tokens_out || 0)), 0);

  // Provider usage
  const providerUsage = {};
  logs.forEach(l => {
    if (!providerUsage[l.provider]) providerUsage[l.provider] = { count: 0, cost: 0 };
    providerUsage[l.provider].count++;
    providerUsage[l.provider].cost += Number(l.cost_usd) || 0;
  });
  const topProviders = Object.entries(providerUsage).sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  const maxCount = topProviders.length > 0 ? topProviders[0][1].count : 1;

  // Daily generation (last 7 days)
  const dailyData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dayStr = d.toDateString();
    const count = projects.filter(p => new Date(p.created_date).toDateString() === dayStr).length;
    dailyData.push({ day: d.toLocaleDateString('vi-VN', { weekday: 'short' }), count });
  }
  const maxDaily = Math.max(...dailyData.map(d => d.count), 1);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto">
        <PageHeader title="Phân Tích" subtitle="Thống kê sử dụng và hiệu suất" />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard icon={Video} label="Tổng dự án" value={totalProjects} color="blue" delay={0} />
          <StatCard icon={Layers} label="Video hoàn thành" value={completed} color="purple" delay={0.05} />
          <StatCard icon={CheckCircle} label="Tỷ lệ thành công" value={`${successRate}%`} color="green" delay={0.1} />
          <StatCard icon={TrendingUp} label="Tokens đã dùng" value={totalTokens.toLocaleString()} color="cyan" delay={0.15} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Daily chart */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-sm font-semibold text-white mb-5">Video tạo theo ngày (7 ngày)</h3>
            <div className="flex items-end justify-between gap-3 h-40">
              {dailyData.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-2">
                  <div className="w-full flex-1 flex items-end">
                    <motion.div
                      initial={{ height: 0 }} animate={{ height: `${(d.count / maxDaily) * 100}%` }}
                      transition={{ delay: i * 0.08, duration: 0.4 }}
                      className="w-full rounded-t-lg bg-gradient-to-t from-blue-600 to-indigo-500 min-h-[2px]"
                    />
                  </div>
                  <div className="text-[10px] text-slate-500">{d.day}</div>
                  <div className="text-xs font-semibold text-slate-300">{d.count}</div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Provider usage */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-sm font-semibold text-white mb-5">Sử dụng theo nhà cung cấp</h3>
            {topProviders.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-500">Chưa có dữ liệu</div>
            ) : (
              <div className="space-y-3">
                {topProviders.map(([name, data]) => (
                  <div key={name}>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300">{name}</span>
                      <span className="text-slate-500">{data.count} lần • ${data.cost.toFixed(2)}</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }} animate={{ width: `${(data.count / maxCount) * 100}%` }}
                        transition={{ duration: 0.5 }}
                        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>

          {/* Status breakdown */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
            className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-sm font-semibold text-white mb-5">Phân bổ trạng thái dự án</h3>
            <div className="space-y-3">
              {Object.entries(STATUS_LABELS).map(([key, cfg]) => {
                const count = projects.filter(p => p.status === key).length;
                if (count === 0) return null;
                const pct = totalProjects > 0 ? (count / totalProjects) * 100 : 0;
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300">{cfg.label}</span>
                      <span className="text-slate-500">{count}</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
                      <div className={`h-full rounded-full ${cfg.color.replace('text-', 'bg-').replace('/15', '')}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
              {totalProjects === 0 && <div className="text-center py-8 text-sm text-slate-500">Chưa có dữ liệu</div>}
            </div>
          </motion.div>

          {/* Job stats */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
            className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-sm font-semibold text-white mb-5">Thống kê job</h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Tổng job', value: jobs.length, icon: BarChart3, color: 'text-blue-400' },
                { label: 'Hoàn thành', value: jobs.filter(j => j.status === 'success' || j.status === 'completed').length, icon: CheckCircle, color: 'text-emerald-400' },
                { label: 'Thất bại', value: jobs.filter(j => j.status === 'failed').length, icon: XCircle, color: 'text-red-400' },
                { label: 'Đang chạy', value: jobs.filter(j => j.status === 'running' || j.status === 'pending').length, icon: TrendingUp, color: 'text-orange-400' },
              ].map(s => (
                <div key={s.label} className="rounded-xl bg-white/[0.02] border border-white/5 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <s.icon className={`w-4 h-4 ${s.color}`} />
                    <span className="text-xs text-slate-400">{s.label}</span>
                  </div>
                  <div className="text-xl font-bold text-white">{s.value}</div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </Layout>
  );
}