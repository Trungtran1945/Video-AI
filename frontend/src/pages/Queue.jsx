import { useState, useEffect, useCallback } from 'react';
import { queueApi } from '@/api/extra';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ListOrdered, RefreshCw, Clock, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { StatusBadge, STAGE_LABELS, formatDate, formatDuration } from '@/lib/constants';
import { friendlyJobError } from '@/lib/providerErrorMessage';
import { useToast } from '@/components/ui/use-toast';

export default function Queue() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [retryingId, setRetryingId] = useState(null);
  const [jobs, setJobs] = useState([]);
  const { toast } = useToast();

  const loadJobs = useCallback(async () => {
    try {
      const data = await queueApi.list();
      setJobs(data || []);
    } catch (e) {
      console.error('Lỗi tải hàng đợi:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadJobs();
  };

  const handleRetry = async (job) => {
    if (retryingId) return;
    setRetryingId(job.id);
    try {
      await projectsApi.retryJob(job.project_id, job.type);
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'running' } : j));
      toast({
        title: 'Đã gửi lại tác vụ',
        description: `Tác vụ ${job.type} đang được chạy lại.`,
      });
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Lỗi chạy lại tác vụ',
        description: e?.response?.data?.message || e.message,
      });
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Hàng Đợi Tạo"
          subtitle={`${jobs.length} tiến trình đang chờ hoặc đã xử lý`}
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

        {loading ? (
          <Loading />
        ) : jobs.length === 0 ? (
          <EmptyState
            icon={ListOrdered}
            title="Hàng đợi hiện tại trống"
            description="Chưa có tác vụ tạo nào đang chờ xử lý. Khởi tạo một dự án mới để kích hoạt pipeline AI."
          />
        ) : (
          <div className="space-y-3">
            {jobs.map((job, i) => {
              const stage = STAGE_LABELS[job.type] || { label: job.type };
              const isRetrying = retryingId === job.id;
              return (
                <motion.div
                  key={job.id ? `${job.id}-${i}` : i}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 sm:p-5 rounded-xl bg-card border border-border hover:border-primary/30 transition-all shadow-xs"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <ListOrdered className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{stage.label}</span>
                      {job.project_title && (
                        <Link
                          to={`/projects/${job.project_id}`}
                          className="text-xs text-primary hover:underline font-medium inline-flex items-center gap-0.5 truncate max-w-[200px]"
                          title={`Xem dự án: ${job.project_title}`}
                        >
                          <span>({job.project_title})</span>
                          <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                        </Link>
                      )}
                      {job.status === 'retry' ? (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 text-xs font-medium">
                          <Clock className="w-3.5 h-3.5" />
                          <span>
                            Đang chờ hồi phục quota{job.next_retry_at ? ` lúc ${new Date(job.next_retry_at).toLocaleTimeString('vi-VN')}` : ''}
                          </span>
                        </div>
                      ) : (
                        <StatusBadge status={job.status} />
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap font-medium">
                      <span className="font-semibold text-foreground/80">{job.provider || 'Hệ thống'}</span>
                      <span>•</span>
                      <span className="font-mono">{formatDate(job.created_date)}</span>
                      <span>•</span>
                      <span className="font-mono">{formatDuration(job.duration_ms)}</span>
                      {job.attempts > 0 && <span>• Thử lại {job.attempts} lần</span>}
                    </div>

                    {job.error_message && (
                      <div className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-2.5 py-1.5 mt-2 max-w-xl">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{friendlyJobError(job.error_message)}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-4 self-end sm:self-center shrink-0">
                    {job.progress != null && job.progress > 0 && job.status === 'running' && (
                      <div className="w-28 text-right">
                        <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono font-semibold mt-1">{job.progress}%</div>
                      </div>
                    )}

                    {job.status === 'failed' && (
                      <button
                        type="button"
                        disabled={isRetrying}
                        onClick={() => handleRetry(job)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/10 hover:bg-primary/20 text-xs font-semibold text-primary transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                      >
                        {isRetrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        <span>Thử lại</span>
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}