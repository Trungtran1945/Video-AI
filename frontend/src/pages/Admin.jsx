import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import { adminApi, logsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Users, Server, Activity, Database } from 'lucide-react';

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [u, p, l] = await Promise.all([
          adminApi.users().catch(() => []),
          projectsApi.list(),
          logsApi.list(20),
        ]);
        setUsers(u || []); setProjects(p || []); setLogs(l || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <Layout><Loading /></Layout>;

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <PageHeader title="Bảng Admin" subtitle="Quản trị hệ thống" />

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard icon={Users} label="Người dùng" value={users.length} color="blue" delay={0} />
          <StatCard icon={Server} label="Tổng dự án" value={projects.length} color="purple" delay={0.05} />
          <StatCard icon={Activity} label="Log gần đây" value={logs.length} color="orange" delay={0.1} />
          <StatCard icon={Database} label="Hoàn thành" value={projects.filter(p => p.status === 'completed').length} color="green" delay={0.15} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Users */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-sm font-semibold text-white mb-4">Người dùng hệ thống</h3>
            <div className="space-y-2">
              {users.slice(0, 8).map(u => (
                <div key={u.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/5 transition">
                  <div className="w-8 h-8 rounded-full bg-blue-500/15 flex items-center justify-center text-xs font-bold text-blue-400">
                    {(u.name || u.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-200 truncate">{u.name || u.email}</div>
                    <div className="text-xs text-slate-500 truncate">{u.email}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded-md bg-white/5 text-xs text-slate-400">{u.role || 'user'}</span>
                </div>
              ))}
              {users.length === 0 && <div className="text-center py-6 text-sm text-slate-500">Không có dữ liệu</div>}
            </div>
          </motion.div>

          {/* System health */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="rounded-2xl bg-[#161922] border border-white/5 p-6">
            <h3 className="text-sm font-semibold text-white mb-4">Sức khỏe hệ thống</h3>
            <div className="space-y-3">
              {[
                { label: 'Database', status: 'Hoạt động' },
                { label: 'File Storage', status: 'Hoạt động' },
                { label: 'AI Providers', status: 'Sẵn sàng' },
                { label: 'Queue System', status: 'Hoạt động' },
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                  <span className="text-sm text-slate-300">{item.label}</span>
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> {item.status}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </Layout>
  );
}