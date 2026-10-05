import { useState, useEffect, useCallback } from 'react';
import { projectsApi } from '@/api/projects';
import { adminApi, logsApi, systemApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { motion } from 'framer-motion';
import {
  Users, Server, Activity, Database, ShieldCheck, RefreshCw,
  Loader2, RotateCcw, HardDrive, Cpu, Trash2,
} from 'lucide-react';
import { formatDate } from '@/lib/constants';
import { useToast } from '@/components/ui/use-toast';

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [logs, setLogs] = useState([]);
  const [health, setHealth] = useState(null);
  const [cleanupTasks, setCleanupTasks] = useState([]);
  const [taskFilter, setTaskFilter] = useState('all');
  const [retryingId, setRetryingId] = useState(null);
  const [roleUpdatingId, setRoleUpdatingId] = useState(null);
  const { toast } = useToast();

  const loadAll = useCallback(async () => {
    try {
      const [u, p, l, h, ct] = await Promise.all([
        adminApi.users().catch(() => []),
        projectsApi.list().catch(() => []),
        logsApi.list(20).catch(() => []),
        systemApi.health().catch(() => null),
        adminApi.cleanupTasks({ limit: 30 }).catch(() => []),
      ]);
      setUsers(u || []);
      setProjects(p || []);
      setLogs(l || []);
      setHealth(h);
      setCleanupTasks(ct || []);
    } catch (e) {
      console.error('Lỗi tải dữ liệu quản trị:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadAll();
  };

  const handleRoleChange = async (userId, newRole) => {
    if (roleUpdatingId) return;
    setRoleUpdatingId(userId);
    try {
      const updated = await adminApi.setRole(userId, newRole);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: updated.role } : u));
      toast({
        title: 'Cập nhật vai trò thành công',
        description: `Người dùng đã được gán vai trò: ${newRole}`,
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi cập nhật vai trò',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setRoleUpdatingId(null);
    }
  };

  const handleRetryCleanup = async (taskId) => {
    if (retryingId) return;
    setRetryingId(taskId);
    try {
      const retried = await adminApi.retryCleanupTask(taskId);
      setCleanupTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...retried, status: 'pending' } : t));
      toast({
        title: 'Đã gửi lại tác vụ dọn dẹp',
        description: 'Tác vụ đã được chuyển sang trạng thái pending để thực thi lại.',
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi thử lại tác vụ',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setRetryingId(null);
    }
  };

  if (loading) return <Layout><Loading /></Layout>;

  const filteredTasks = taskFilter === 'all'
    ? cleanupTasks
    : cleanupTasks.filter(t => t.status === taskFilter);

  const persistenceState = health?.database?.persistenceState || 'HEALTHY';
  const isPersistenceHealthy = persistenceState === 'HEALTHY';
  const isPersistenceDegraded = persistenceState === 'DEGRADED';

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Bảng Quản Trị Hệ Thống"
          subtitle="Giám sát người dùng, tổng thể dự án và trạng thái các dịch vụ cốt lõi"
          action={
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-card border border-border hover:bg-muted text-foreground text-xs sm:text-sm font-medium transition shadow-xs disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
              <span>{refreshing ? 'Đang cập nhật...' : 'Làm mới'}</span>
            </button>
          }
        />

        {/* Stat Cards */}
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

        {/* 2-Column Grid: Users & Real System Health */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Users Management */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Người dùng hệ thống</h3>
                    <p className="text-[11px] text-muted-foreground">Phân quyền tài khoản (admin, user, guest)</p>
                  </div>
                </div>
                <span className="text-xs font-mono font-medium text-muted-foreground">
                  {users.length} tài khoản
                </span>
              </div>

              <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
                {users.map(u => {
                  const isUpdating = roleUpdatingId === u.id;
                  return (
                    <div
                      key={u.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/60 border border-border/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                          {(u.name || u.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-foreground truncate">{u.name || u.email}</div>
                          <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <select
                          value={u.role || 'user'}
                          disabled={isUpdating}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          className="text-xs px-2.5 py-1 rounded-md bg-background border border-input text-foreground font-medium focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                          <option value="guest">Guest</option>
                        </select>
                        {isUpdating && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />}
                      </div>
                    </div>
                  );
                })}
                {users.length === 0 && (
                  <div className="text-center py-8 text-sm text-muted-foreground">Không có dữ liệu người dùng</div>
                )}
              </div>
            </div>
          </motion.div>

          {/* Real System Health (from /health) */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="rounded-xl bg-card border border-border p-6 shadow-xs flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Sức khỏe hệ thống</h3>
                    <p className="text-[11px] text-muted-foreground">Telemetries thời gian thực từ /health</p>
                  </div>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  health?.status === 'ok'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25'
                    : health?.status === 'degraded'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25'
                    : 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    health?.status === 'ok' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                  }`} />
                  <span>{health?.status ? health.status.toUpperCase() : 'DEGRADED'}</span>
                </span>
              </div>

              <div className="space-y-3">
                {/* SQLite Persistence */}
                <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                  <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5 text-primary" />
                      <span>Cơ sở dữ liệu (SQLite / sql.js)</span>
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                      isPersistenceHealthy
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : isPersistenceDegraded
                        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                        : 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
                    }`}>
                      {persistenceState}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-3">
                    <span>Ghi file: {health?.database?.consecutiveSaveFailures ?? 0} lỗi liên tiếp</span>
                    <span>•</span>
                    <span>Hàng đợi ghi: {health?.writes?.active ?? 0} active / {health?.writes?.queued ?? 0} queued</span>
                  </div>
                </div>

                {/* Queue & Workers */}
                <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                  <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5 text-primary" />
                      <span>Hàng đợi tiến trình (BullMQ / Redis)</span>
                    </span>
                    <span className="text-xs font-medium text-foreground/80">
                      {health?.redis === 'connected' ? 'Redis kết nối' : 'In-process (Dev mode)'}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    BullMQ: {health?.bullmq === 'available' ? 'Sẵn sàng điều phối worker' : 'In-process workers sau waitForRedis (3000ms)'}
                  </div>
                </div>

                {/* Safe Media Storage */}
                <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                  <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5 text-primary" />
                      <span>Lưu trữ video (Local /storage)</span>
                    </span>
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      SafeMediaStatic OK
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Phục vụ file an toàn chống path traversal qua tiền tố /storage
                  </div>
                </div>

                {/* Durable Cleanup Outbox */}
                <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
                  <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Trash2 className="w-3.5 h-3.5 text-primary" />
                      <span>Hàng đợi dọn dẹp (Durable Cleanup Outbox)</span>
                    </span>
                    <span className="text-xs font-mono text-foreground/90">
                      {health?.cleanup?.pending ?? 0} chờ • {health?.cleanup?.failed ?? 0} lỗi
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Tiến trình quét dọn project_cleanup_tasks định kỳ mỗi 60s
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Section: Durable Cleanup Outbox Tasks Table */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          className="rounded-xl bg-card border border-border p-6 shadow-xs"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Trash2 className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Tác vụ dọn dẹp hệ thống (Cleanup Outbox)</h3>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Các tác vụ xoá storage/artifact của dự án đã bị huỷ hoặc hết hạn lưu trữ
              </p>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1 bg-muted/50 p-0.5 rounded-lg text-xs self-start sm:self-auto">
              {[
                { id: 'all', label: 'Tất cả' },
                { id: 'pending', label: 'Đang chờ' },
                { id: 'failed', label: 'Lỗi' },
                { id: 'done', label: 'Đã xong' },
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setTaskFilter(f.id)}
                  className={`px-3 py-1 rounded-md font-medium transition-all ${
                    taskFilter === f.id
                      ? 'bg-background text-foreground shadow-xs font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {filteredTasks.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground italic">
              Không có tác vụ dọn dẹp nào phù hợp với bộ lọc hiện tại.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-muted-foreground font-semibold">
                    <th className="pb-2 pl-2">Mã tác vụ</th>
                    <th className="pb-2">Hành động</th>
                    <th className="pb-2">Trạng thái</th>
                    <th className="pb-2">Số lần thử</th>
                    <th className="pb-2">Lần thử kế / Lỗi</th>
                    <th className="pb-2 text-right pr-2">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {filteredTasks.map(t => {
                    const isRetrying = retryingId === t.id;
                    return (
                      <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 pl-2 font-mono text-[11px] text-foreground">
                          {t.id.slice(0, 8)}...
                        </td>
                        <td className="py-2.5 font-medium text-foreground">
                          {t.operation || 'Dọn dẹp'}
                        </td>
                        <td className="py-2.5">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            t.status === 'done'
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20'
                              : t.status === 'failed'
                              ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20'
                              : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
                          }`}>
                            <span>{t.status}</span>
                          </span>
                        </td>
                        <td className="py-2.5 font-mono text-muted-foreground">
                          {t.attempts ?? 0}
                        </td>
                        <td className="py-2.5 text-muted-foreground max-w-xs truncate">
                          {t.last_error ? (
                            <span className="text-destructive font-mono text-[10px]" title={t.last_error}>
                              {t.last_error}
                            </span>
                          ) : t.next_attempt_at ? (
                            <span className="font-mono text-[11px]">
                              {formatDate(t.next_attempt_at)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2.5 text-right pr-2">
                          {t.status === 'failed' && (
                            <button
                              onClick={() => handleRetryCleanup(t.id)}
                              disabled={isRetrying}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30 transition disabled:opacity-50"
                            >
                              {isRetrying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                              <span>Thử lại</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>
      </div>
    </Layout>
  );
}