import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import { queueApi, logsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Video, Zap, ListOrdered, HardDrive, Cpu, Clock, ArrowRight, Plus, CheckCircle, Film } from 'lucide-react';
import { STAGE_LABELS, STAGE_ORDER, formatDate } from '@/lib/constants';

export default function Dashboard() {
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
          logsApi.list(5),
        ]);
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

  const todayProjects = (projects || []).filter(p => {
    const d = new Date(p.created_date);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const completed = (projects || []).filter(p => p.status === 'completed');
  const runningJobs = (jobs || []).filter(j => j.status === 'running' || j.status === 'pending');
  const totalCredits = (logs || []).reduce((s, l) => s + (l.cost_estimate || 0), 0);

  const stages = STAGE_ORDER.map(s => STAGE_LABELS[s]);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <PageHeader
          title="Bảng Điều Khiển"
          subtitle="Tổng quan hoạt động tạo video của bạn"
          action={
            <Link to="/projects/new" className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition shadow-lg shadow-blue-600/20">
              <Plus className="w-4 h-4" /> Tạo Dự Án Mới
            </Link>
          }
        />

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard icon={Video} label="Video hôm nay" value={todayProjects.length} color="blue" delay={0} />
          <StatCard icon={Zap} label="Credits đã dùng" value={totalCredits.toFixed(0)} color="purple" delay={0.05} />
          <StatCard icon={ListOrdered} label="Job đang chạy" value={runningJobs.length} color="orange" delay={0.1} />
          <StatCard icon={HardDrive} label="Video hoàn thành" value={completed.length} color="green" delay={0.15} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Pipeline visual */}
          <div className="lg:col-span-2 rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-base font-semibold text-white mb-5">Quy Trình Pipeline</h3>
            <div className="flex flex-wrap gap-2">
              {stages.map((stage, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.06 }}
                  className="flex items-center gap-2"
                >
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/5 text-sm text-slate-300">
                    <span className="text-xs text-slate-500 font-mono">{i + 1}</span>
                    {stage.label}
                  </div>
                  {i < stages.length - 1 && <ArrowRight className="w-3 h-3 text-slate-600" />}
                </motion.div>
              ))}
            </div>

            {/* Recent projects */}
            <div className="mt-8">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-semibold text-slate-300">Dự án gần đây</h4>
                <Link to="/projects" className="text-xs text-blue-400 hover:text-blue-300">Xem tất cả →</Link>
              </div>
              <div className="space-y-2">
                {(projects || []).slice(0, 4).map(p => (
                  <Link key={p.id} to={`/projects/${p.id}`}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition group"
                  >
                    <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                      <Film className="w-4 h-4 text-blue-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-200 truncate">{p.title}</div>
                      <div className="text-xs text-slate-500">{formatDate(p.created_date)}</div>
                    </div>
                    <div className="w-24 h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${p.progress || 0}%` }} />
                    </div>
                    <span className="text-xs text-slate-500 w-10 text-right">{p.progress || 0}%</span>
                  </Link>
                ))}
                {projects.length === 0 && (
                  <div className="text-center py-8 text-sm text-slate-500">Chưa có dự án nào. <Link to="/projects/new" className="text-blue-400">Tạo ngay →</Link></div>
                )}
              </div>
            </div>
          </div>

          {/* Side column */}
          <div className="space-y-6">
            {/* Queue status */}
            <div className="rounded-2xl bg-[#161922] border border-white/5 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Cpu className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-semibold text-white">Trạng thái nhà cung cấp</h3>
              </div>
              <div className="space-y-3">
                {['LLM', 'Hình ảnh', 'Video', 'Giọng nói', 'Phụ đề'].map(cat => (
                  <div key={cat} className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">{cat}</span>
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Sẵn sàng
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent logs */}
            <div className="rounded-2xl bg-[#161922] border border-white/5 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-semibold text-white">Hoạt động gần đây</h3>
              </div>
              <div className="space-y-3">
                {(logs || []).slice(0, 5).map(log => (
                  <div key={log.id} className="flex items-center gap-2 text-xs">
                    {log.status === 'success' ? (
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <span className="w-3.5 h-3.5 rounded-full bg-red-500/20 shrink-0" />
                    )}
                    <span className="text-slate-300 truncate">{log.provider}</span>
                    <span className="text-slate-600 ml-auto">{formatDate(log.created_date)}</span>
                  </div>
                ))}
                {logs.length === 0 && <div className="text-xs text-slate-500 text-center py-4">Chưa có hoạt động</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}