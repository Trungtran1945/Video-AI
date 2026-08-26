import { useState, useEffect } from 'react';
import { queueApi } from '@/api/extra';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { motion } from 'framer-motion';
import { ListOrdered, RefreshCw } from 'lucide-react';
import { StatusBadge, STAGE_LABELS, formatDate, formatDuration } from '@/lib/constants';

export default function Queue() {
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const data = await queueApi.list();
        setJobs(data || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  const handleRetry = async (job) => {
    try {
      await projectsApi.retryJob(job.project_id, job.type);
      setJobs(jobs.map(j => j.id === job.id ? { ...j, status: 'running' } : j));
    } catch (e) { console.error(e); }
  };

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <PageHeader title="Hàng Đợi Tạo" subtitle={`${jobs.length} job tổng cộng`} />

        {loading ? <Loading /> : jobs.length === 0 ? (
          <EmptyState icon={ListOrdered} title="Hàng đợi trống" description="Chưa có job tạo nào. Tạo dự án để bắt đầu pipeline." />
        ) : (
          <div className="space-y-2">
            {jobs.map((job, i) => {
              const stage = STAGE_LABELS[job.type] || { label: job.type };
              return (
                <motion.div
                  key={job.id}
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center gap-4 p-4 rounded-xl bg-[#161922] border border-white/5 hover:border-white/10 transition"
                >
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                    <ListOrdered className="w-4 h-4 text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-200">{stage.label}</span>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {job.provider || '—'} • {formatDate(job.created_date)} • {formatDuration(job.duration_ms)}
                      {job.attempts > 0 && ` • Thử lại ${job.attempts} lần`}
                    </div>
                    {job.error_message && <div className="text-xs text-red-400 mt-1 truncate">{job.error_message}</div>}
                  </div>
                  {job.progress != null && job.progress > 0 && job.status === 'running' && (
                    <div className="w-24 hidden sm:block">
                      <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${job.progress}%` }} />
                      </div>
                      <div className="text-xs text-slate-500 text-center mt-1">{job.progress}%</div>
                    </div>
                  )}
                  {job.status === 'failed' && (
                    <button onClick={() => handleRetry(job)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-slate-300 transition">
                      <RefreshCw className="w-3 h-3" /> Thử lại
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}