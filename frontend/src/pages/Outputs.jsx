import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Film, Play, Youtube, Search } from 'lucide-react';
import { formatDate, LANGUAGE_LABELS } from '@/lib/constants';

export default function Outputs() {
  const [loading, setLoading] = useState(true);
  const [outputs, setOutputs] = useState([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await projectsApi.list();
        setOutputs((data || []).filter((p) => p.status === 'completed'));
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  const filtered = (outputs || []).filter(o =>
    o.title?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto">
        <PageHeader title="Đầu Ra" subtitle={`${outputs.length} video hoàn thành`} />

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Tìm video..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#161922] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50"
          />
        </div>

        {loading ? <Loading /> : filtered.length === 0 ? (
          <EmptyState icon={Film} title="Chưa có video hoàn thành" description="Các video đã tạo xong sẽ hiển thị tại đây." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((o, i) => (
              <motion.div
                key={o.id}
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="rounded-2xl bg-[#161922] border border-white/5 overflow-hidden group hover:border-blue-500/20 transition"
              >
                <div className="relative aspect-video bg-gradient-to-br from-blue-600/20 to-indigo-600/10 flex items-center justify-center">
                  <Film className="w-10 h-10 text-slate-600" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                    <Link to={`/projects/${o.id}`} className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center"><Play className="w-4 h-4 text-white" /></Link>
                  </div>
                  <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white">{o.target_duration_sec}s</span>
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-white text-sm truncate">{o.title}</h3>
                  <p className="text-xs text-slate-500 mt-1">{LANGUAGE_LABELS[o.language] || o.language} • {formatDate(o.created_date)}</p>
                  <div className="flex items-center gap-2 mt-3">
                    <Link to={`/projects/${o.id}`} className="text-xs text-blue-400 hover:text-blue-300">Chi tiết →</Link>
                    <button className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-400 transition ml-auto">
                      <Youtube className="w-3.5 h-3.5" /> Tải lên YouTube
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}