import { useState, useEffect } from 'react';
import { logsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { motion } from 'framer-motion';
import { ScrollText, AlertCircle } from 'lucide-react';
import { StatusBadge, formatDate, formatDuration } from '@/lib/constants';

const categoryLabels = { llm: 'LLM', image: 'Hình ảnh', video: 'Video', voice: 'Giọng nói', subtitle: 'Phụ đề' };

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    (async () => {
      try {
        setLogs(await logsApi.list(100) || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.status === filter);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Nhật Ký Lời Gọi"
          subtitle={`${logs.length} bản ghi chi tiết các yêu cầu tới nhà cung cấp AI`}
        />

        <div className="flex gap-2">
          {[
            { id: 'all', label: 'Tất cả' },
            { id: 'success', label: 'Thành công' },
            { id: 'error', label: 'Có lỗi' },
            { id: 'timeout', label: 'Quá hạn' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                filter === f.id
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="Chưa có bản ghi nhật ký nào"
            description="Mọi yêu cầu gửi tới các nhà cung cấp AI (LLM, TTS, Render) sẽ được tự động ghi lại tại đây."
          />
        ) : (
          <div className="space-y-3">
            {filtered.map((log, i) => (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02 }}
                className="flex items-start justify-between gap-4 p-4 rounded-xl bg-card border border-border hover:border-primary/30 transition-all shadow-xs"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-foreground">{log.provider}</span>
                    <span className="px-2 py-0.5 rounded-md bg-muted text-[10px] font-semibold text-muted-foreground uppercase">
                      {categoryLabels[log.type] || log.type}
                    </span>
                    <StatusBadge status={log.status} />
                  </div>
                  {log.error_message && (
                    <div className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-2.5 py-1.5 mt-2 max-w-xl">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{log.error_message}</span>
                    </div>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <div className="text-xs font-semibold text-foreground">{formatDuration(log.duration_ms)}</div>
                  {((log.tokens_in || 0) + (log.tokens_out || 0)) > 0 && (
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {((log.tokens_in || 0) + (log.tokens_out || 0)).toLocaleString()} tokens
                    </div>
                  )}
                  {log.cost_usd > 0 && (
                    <div className="text-xs font-bold text-primary mt-0.5">
                      ${Number(log.cost_usd).toFixed(3)}
                    </div>
                  )}
                  <div className="text-[11px] text-muted-foreground mt-1">{formatDate(log.created_date)}</div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}