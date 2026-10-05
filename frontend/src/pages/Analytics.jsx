import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import { analyticsApi, logsApi, queueApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { BarChart3, Video, CheckCircle, XCircle, TrendingUp, Layers, Clock, Clapperboard, Languages } from 'lucide-react';

export default function Analytics() {
  const [loading, setLoading] = useState(true);
  const [analytics, setAnalytics] = useState(null);
  const [projects, setProjects] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [a, p, j, l] = await Promise.all([
          analyticsApi.get().catch(() => null),
          projectsApi.list().catch(() => []),
          queueApi.list().catch(() => []),
          logsApi.list(100).catch(() => []),
        ]);
        setAnalytics(a);
        setProjects(p || []);
        setJobs(j || []);
        setLogs(l || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Layout><Loading /></Layout>;

  const totalProjects = analytics?.totalProjects ?? projects.length;
  const completed = analytics?.completed ?? projects.filter(p => p.status === 'completed').length;
  const successRate = totalProjects > 0 ? Math.round((completed / totalProjects) * 100) : 0;
  const minutesTranslated = analytics?.minutesTranslated ?? 0;
  const totalTokens = logs.reduce((s, l) => s + ((l.tokens_in || 0) + (l.tokens_out || 0)), 0);

  // Provider usage: prefer backend analytics.byProvider
  const providerList = analytics?.byProvider && analytics.byProvider.length > 0
    ? analytics.byProvider
    : Object.entries(
        logs.reduce((acc, l) => {
          if (!acc[l.provider]) acc[l.provider] = { calls: 0, costUsd: 0, successCalls: 0 };
          acc[l.provider].calls++;
          if (l.status === 'success' || l.status === 'ok') acc[l.provider].successCalls++;
          acc[l.provider].costUsd += Number(l.cost_usd) || 0;
          return acc;
        }, {})
      ).map(([provider, data]) => ({ provider, ...data }));

  const topProviders = [...providerList].sort((a, b) => (b.calls || 0) - (a.calls || 0)).slice(0, 6);
  const maxCount = topProviders.length > 0 ? Math.max(...topProviders.map(p => p.calls || 0), 1) : 1;

  // Daily generation (prefer backend analytics.byDay)
  const dailyData = [];
  if (analytics?.byDay && analytics.byDay.length > 0) {
    const dayMap = new Map(analytics.byDay.map(d => [d.day, d.c]));
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const isoDay = d.toISOString().split('T')[0];
      const count = dayMap.get(isoDay) || 0;
      dailyData.push({ day: d.toLocaleDateString('vi-VN', { weekday: 'short' }), count });
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = d.toDateString();
      const count = projects.filter(p => new Date(p.created_date).toDateString() === dayStr).length;
      dailyData.push({ day: d.toLocaleDateString('vi-VN', { weekday: 'short' }), count });
    }
  }
  const maxDaily = Math.max(...dailyData.map(d => d.count), 1);

  // Mode distribution
  const byMode = analytics?.byMode || [];
  const modeStats = {
    SUMMARY: byMode.find(m => String(m.mode).toUpperCase() === 'SUMMARY')?.c ??
      projects.filter(p => String(p.mode).toUpperCase() === 'SUMMARY').length,
    TRANSLATE_DUB: byMode.find(m => String(m.mode).toUpperCase() === 'TRANSLATE_DUB')?.c ??
      projects.filter(p => String(p.mode).toUpperCase() === 'TRANSLATE_DUB').length,
  };

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Phân Tích &amp; Hiệu Suất"
          subtitle="Thống kê lưu lượng sử dụng, tần suất tạo và chi phí nhà cung cấp"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard icon={Video} label="Tổng dự án" value={totalProjects} color="blue" delay={0} />
          <StatCard icon={Layers} label="Đã hoàn thành" value={completed} color="purple" delay={0.04} />
          <StatCard icon={Clock} label="Thời lượng dịch" value={`${minutesTranslated}p`} color="orange" delay={0.08} />
          <StatCard icon={CheckCircle} label="Tỷ lệ thành công" value={`${successRate}%`} color="green" delay={0.12} />
          <StatCard icon={TrendingUp} label="Tokens AI đã dùng" value={totalTokens.toLocaleString()} color="cyan" delay={0.16} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Daily chart */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs"
          >
            <h3 className="text-base font-semibold text-foreground mb-1">Video tạo theo ngày (7 ngày qua)</h3>
            <p className="text-xs text-muted-foreground mb-6">Số lượng video bắt đầu quy trình tạo mỗi ngày</p>
            <div className="flex items-end justify-between gap-3 h-44 pt-4">
              {dailyData.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-2">
                  <div className="w-full flex-1 flex items-end">
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: `${(d.count / maxDaily) * 100}%` }}
                      transition={{ delay: i * 0.06, duration: 0.35 }}
                      className="w-full rounded-t-md bg-primary hover:bg-primary/90 transition-colors min-h-[4px]"
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground font-medium">{d.day}</div>
                  <div className="text-xs font-bold text-foreground">{d.count}</div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Provider usage */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs"
          >
            <h3 className="text-base font-semibold text-foreground mb-1">Sử dụng theo nhà cung cấp</h3>
            <p className="text-xs text-muted-foreground mb-6">Tần suất gọi API, tỷ lệ thành công và chi phí ước tính</p>
            {topProviders.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">Chưa có dữ liệu nhà cung cấp</div>
            ) : (
              <div className="space-y-4">
                {topProviders.map((data) => {
                  const name = data.provider;
                  const calls = data.calls || 0;
                  const cost = Number(data.costUsd || data.cost || 0);
                  const successCalls = data.successCalls || 0;
                  const pct = calls > 0 ? Math.round((successCalls / calls) * 100) : 100;
                  return (
                    <div key={name}>
                      <div className="flex items-center justify-between text-xs mb-1.5 font-medium">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground font-semibold">{name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">({pct}% OK)</span>
                        </div>
                        <span className="text-muted-foreground">{calls} lần • ${cost.toFixed(3)}</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${(calls / maxCount) * 100}%` }}
                          transition={{ duration: 0.5 }}
                          className="h-full rounded-full bg-primary"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>

          {/* Mode distribution */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs"
          >
            <h3 className="text-base font-semibold text-foreground mb-1">Phân bổ theo chế độ sản xuất</h3>
            <p className="text-xs text-muted-foreground mb-6">Tỷ lệ sử dụng giữa Review Phim và Dịch &amp; Lồng tiếng</p>
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5 font-medium">
                  <span className="text-foreground flex items-center gap-1.5">
                    <Clapperboard className="w-3.5 h-3.5 text-primary" />
                    <span>Review Phim (SUMMARY)</span>
                  </span>
                  <span className="text-muted-foreground font-mono">
                    {modeStats.SUMMARY} ({totalProjects > 0 ? Math.round((modeStats.SUMMARY / totalProjects) * 100) : 0}%)
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${totalProjects > 0 ? (modeStats.SUMMARY / totalProjects) * 100 : 0}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1.5 font-medium">
                  <span className="text-foreground flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-primary" />
                    <span>Dịch &amp; Lồng Tiếng (TRANSLATE_DUB)</span>
                  </span>
                  <span className="text-muted-foreground font-mono">
                    {modeStats.TRANSLATE_DUB} ({totalProjects > 0 ? Math.round((modeStats.TRANSLATE_DUB / totalProjects) * 100) : 0}%)
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/80 transition-all"
                    style={{ width: `${totalProjects > 0 ? (modeStats.TRANSLATE_DUB / totalProjects) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
          </motion.div>

          {/* Job stats */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.16 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs"
          >
            <h3 className="text-base font-semibold text-foreground mb-1">Thống kê tác vụ (Jobs)</h3>
            <p className="text-xs text-muted-foreground mb-6">Tổng kết hiệu suất thực thi của worker queue</p>
            <div className="grid grid-cols-2 gap-3.5">
              {[
                { label: 'Tổng tác vụ', value: jobs.length, icon: BarChart3, color: 'text-primary bg-primary/10' },
                {
                  label: 'Thành công',
                  value: jobs.filter(j => j.status === 'success' || j.status === 'completed').length,
                  icon: CheckCircle,
                  color: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
                },
                {
                  label: 'Thất bại',
                  value: jobs.filter(j => j.status === 'failed').length,
                  icon: XCircle,
                  color: 'text-rose-600 dark:text-rose-400 bg-rose-500/10',
                },
                {
                  label: 'Đang chạy',
                  value: jobs.filter(j => j.status === 'running' || j.status === 'pending').length,
                  icon: TrendingUp,
                  color: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
                },
              ].map(s => {
                const Icon = s.icon;
                return (
                  <div key={s.label} className="rounded-xl bg-muted/40 border border-border/70 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${s.color}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <span className="text-xs text-muted-foreground font-medium">{s.label}</span>
                    </div>
                    <div className="text-xl font-bold text-foreground">{s.value}</div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </div>
      </div>
    </Layout>
  );
}