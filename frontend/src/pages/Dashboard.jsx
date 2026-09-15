import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import { queueApi, logsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Video, Layers, ListOrdered, HardDrive, Cpu, Clock, ArrowRight, Plus, CheckCircle2, Film } from 'lucide-react';
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

  const stages = STAGE_ORDER.map(s => STAGE_LABELS[s]);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
        <PageHeader
          title="Bảng Điều Khiển"
          subtitle="Tổng quan hoạt động sản xuất video và tiến độ các hàng đợi"
          action={
            <Link
              to="/projects/new"
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition shadow-md shadow-primary/20"
            >
              <Plus className="w-4 h-4" />
              <span>Tạo Dự Án Mới</span>
            </Link>
          }
        />

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard icon={Video} label="Video hôm nay" value={todayProjects.length} color="blue" delay={0} />
          <StatCard icon={Layers} label="Tổng dự án" value={(projects || []).length} color="purple" delay={0.05} />
          <StatCard icon={ListOrdered} label="Job đang chạy" value={runningJobs.length} color="orange" delay={0.1} />
          <StatCard icon={HardDrive} label="Video hoàn thành" value={completed.length} color="green" delay={0.15} />
        </div>

        {/* Main Content Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Pipeline visual & Recent Projects */}
          <div className="lg:col-span-2 rounded-2xl bg-card border border-border p-6 shadow-sm">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-semibold text-foreground">Quy Trình Pipeline Tự Động</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Các bước xử lý khép kín từ nhận dạng đến kết xuất</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {stages.map((stage, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center gap-2"
                >
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/60 border border-border/80 text-xs sm:text-sm text-foreground hover:bg-muted transition-colors">
                    <span className="text-[10px] text-muted-foreground font-mono font-semibold">{i + 1}</span>
                    <span>{stage.label}</span>
                  </div>
                  {i < stages.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
                </motion.div>
              ))}
            </div>

            {/* Recent projects */}
            <div className="mt-8 pt-6 border-t border-border">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-semibold text-foreground">Dự án gần đây</h4>
                <Link to="/projects" className="text-xs font-medium text-primary hover:underline flex items-center gap-1">
                  <span>Xem tất cả</span>
                  <ArrowRight className="w-3 h-3" />
                </Link>
              </div>

              <div className="space-y-2">
                {(projects || []).slice(0, 4).map(p => (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="flex items-center gap-3.5 p-3 rounded-xl hover:bg-muted/60 border border-transparent hover:border-border/60 transition-all group"
                  >
                    <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <Film className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
                        {p.title}
                      </div>
                      <div className="text-xs text-muted-foreground">{formatDate(p.created_date)}</div>
                    </div>
                    <div className="w-24 sm:w-32 hidden xs:block">
                      <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all"
                          style={{ width: `${p.progress || 0}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs font-medium text-muted-foreground w-10 text-right">{p.progress || 0}%</span>
                  </Link>
                ))}

                {projects.length === 0 && (
                  <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-border rounded-xl">
                    Chưa có dự án nào.{' '}
                    <Link to="/projects/new" className="text-primary font-semibold hover:underline">
                      Tạo ngay →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Provider status & Activity logs */}
          <div className="space-y-6">
            {/* Provider status */}
            <div className="rounded-2xl bg-card border border-border p-6 shadow-sm">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Cpu className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Trạng thái nhà cung cấp</h3>
                  <p className="text-[11px] text-muted-foreground">Các phân hệ AI lõi</p>
                </div>
              </div>
              <div className="space-y-2.5">
                {['LLM / Biên kịch', 'Tạo hình ảnh', 'Tạo video', 'Giọng nói AI', 'Phụ đề & OCR'].map(cat => (
                  <div key={cat} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0 text-xs">
                    <span className="text-muted-foreground font-medium">{cat}</span>
                    <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span>Sẵn sàng</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent logs */}
            <div className="rounded-2xl bg-card border border-border p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <Clock className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Hoạt động gần đây</h3>
                    <p className="text-[11px] text-muted-foreground">Nhật ký các lệnh gọi API</p>
                  </div>
                </div>
                <Link to="/logs" className="text-xs text-primary hover:underline">
                  Xem tất cả
                </Link>
              </div>

              <div className="space-y-2.5">
                {(logs || []).slice(0, 5).map(log => (
                  <div key={log.id} className="flex items-center gap-2.5 text-xs py-1.5 border-b border-border/40 last:border-0">
                    {log.status === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <span className="w-4 h-4 rounded-full bg-destructive/15 text-destructive flex items-center justify-center text-[10px] font-bold shrink-0">!</span>
                    )}
                    <span className="text-foreground font-medium truncate">{log.provider}</span>
                    <span className="text-muted-foreground ml-auto text-[11px]">{formatDate(log.created_date)}</span>
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-6">Chưa có hoạt động</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}