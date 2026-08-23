import { useState, useEffect } from 'react';
import { logsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { motion } from 'framer-motion';
import { ScrollText } from 'lucide-react';
import { StatusBadge, formatDate, formatDuration } from '@/lib/constants';

const categoryLabels = { llm: 'LLM', image: 'Hình ảnh', video: 'Video', voice: 'Giọng nói', subtitle: 'Phụ đề' };

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    (async () => {
      try { setLogs(await logsApi.list(100) || []); }
      catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.status === filter);

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-4xl mx-auto">
        <PageHeader title="Nhật Ký" subtitle={`${logs.length} bản ghi nhà cung cấp`} />

        <div className="flex gap-2 mb-4">
          {['all', 'success', 'error', 'timeout'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                filter === f ? 'bg-blue-600 text-white' : 'bg-white/5 text-slate-400 hover:text-white'
              }`}>
              {f === 'all' ? 'Tất cả' : f === 'success' ? 'Thành công' : f === 'error' ? 'Lỗi' : 'Quá hạn'}
            </button>
          ))}
        </div>

        {loading ? <Loading /> : filtered.length === 0 ? (
          <EmptyState icon={ScrollText} title="Chưa có nhật ký nào" description="Mỗi lời gọi AI provider sẽ được ghi lại tại đây." />
        ) : (
          <div className="space-y-2">
            {filtered.map((log, i) => (
              <motion.div key={log.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }}
                className="flex items-start gap-4 p-4 rounded-xl bg-[#161922] border border-white/5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-white">{log.provider}</span>
                    <span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px] text-slate-400 uppercase">{categoryLabels[log.type] || log.type}</span>
                    <StatusBadge status={log.status} />
                  </div>
                  {log.error_message && <div className="text-xs text-red-400 mt-1">{log.error_message}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-slate-500">{formatDuration(log.duration_ms)}</div>
                  {((log.tokens_in || 0) + (log.tokens_out || 0)) > 0 && <div className="text-xs text-slate-500">{((log.tokens_in || 0) + (log.tokens_out || 0))} tokens</div>}
                  {log.cost_usd > 0 && <div className="text-xs text-blue-400">${Number(log.cost_usd).toFixed(2)}</div>}
                  <div className="text-xs text-slate-600 mt-1">{formatDate(log.created_date)}</div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}