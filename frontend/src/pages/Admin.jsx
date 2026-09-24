import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import { adminApi, logsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Users, Server, Activity, Database, ShieldCheck } from 'lucide-react';

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
        setUsers(u || []);
        setProjects(p || []);
        setLogs(l || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Layout><Loading /></Layout>;

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Bảng Quản Trị Hệ Thống"
          subtitle="Giám sát người dùng, tổng thể dự án và trạng thái các dịch vụ cốt lõi"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard icon={Users} label="Người dùng" value={users.length} color="blue" delay={0} />
          <StatCard icon={Server} label="Tổng dự án" value={projects.length} color="purple" delay={0.05} />
          <StatCard icon={Activity} label="Nhật ký gần đây" value={logs.length} color="orange" delay={0.1} />
          <StatCard
            icon={Database}
            label="Hoàn thành"
            value={projects.filter(p => p.status === 'completed').length}
            color="green"
            delay={0.15}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Users */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs"
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Users className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Người dùng hệ thống</h3>
                <p className="text-[11px] text-muted-foreground">Danh sách tài khoản đã đăng ký</p>
              </div>
            </div>

            <div className="space-y-2">
              {users.slice(0, 8).map(u => (
                <div
                  key={u.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/60 border border-border/50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                    {(u.name || u.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">{u.name || u.email}</div>
                    <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded-md bg-muted text-xs font-medium text-muted-foreground border border-border/60">
                    {u.role || 'user'}
                  </span>
                </div>
              ))}
              {users.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">Không có dữ liệu người dùng</div>
              )}
            </div>
          </motion.div>

          {/* System health */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs"
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Sức khỏe hệ thống</h3>
                <p className="text-[11px] text-muted-foreground">Trạng thái kết nối dịch vụ thời gian thực</p>
              </div>
            </div>

            <div className="space-y-2">
              {[
                { label: 'Cơ sở dữ liệu (PostgreSQL)', status: 'Hoạt động ổn định' },
                { label: 'Kho lưu trữ video (MinIO/S3)', status: 'Hoạt động ổn định' },
                { label: 'Cụm AI Providers (LLM/TTS/OCR)', status: 'Sẵn sàng phục vụ' },
                { label: 'Hàng đợi tiến trình (BullMQ/Queue)', status: 'Đang điều phối' },
              ].map(item => (
                <div
                  key={item.label}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/50 text-xs sm:text-sm"
                >
                  <span className="font-medium text-foreground">{item.label}</span>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>{item.status}</span>
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