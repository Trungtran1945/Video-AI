import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Film, Play, Youtube, Search, ArrowRight } from 'lucide-react';
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
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = (outputs || []).filter(o =>
    o.title?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Đầu Ra Video"
          subtitle={`${outputs.length} video đã hoàn thành và sẵn sàng xuất bản`}
        />

        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm kiếm video thành phẩm..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {loading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Film}
            title={search ? 'Không tìm thấy video nào' : 'Chưa có video thành phẩm'}
            description={
              search
                ? 'Thử tìm với tên hoặc tiêu đề khác.'
                : 'Các video tạo hoàn tất từ các dự án sẽ được lưu trữ và hiển thị tại đây.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((o, i) => (
              <motion.div
                key={o.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="rounded-2xl bg-card border border-border overflow-hidden group hover:border-primary/40 hover:shadow-lg transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="relative aspect-video bg-gradient-to-br from-primary/15 via-muted to-muted/60 flex items-center justify-center overflow-hidden">
                    <Film className="w-10 h-10 text-muted-foreground/60 group-hover:scale-110 transition-transform duration-300" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Link
                        to={`/projects/${o.id}`}
                        className="w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg transform scale-90 group-hover:scale-100 transition-transform"
                      >
                        <Play className="w-5 h-5 fill-current ml-0.5" />
                      </Link>
                    </div>
                    <span className="absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded-md bg-black/75 text-[11px] font-semibold text-white tracking-wide">
                      {o.target_duration_sec}s
                    </span>
                  </div>

                  <div className="p-4 sm:p-5">
                    <h3 className="font-bold text-foreground text-sm sm:text-base truncate group-hover:text-primary transition-colors">
                      {o.title}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1 font-medium">
                      {LANGUAGE_LABELS[o.language] || o.language} • {formatDate(o.created_date)}
                    </p>
                  </div>
                </div>

                <div className="px-4 sm:px-5 pb-4 pt-1 flex items-center justify-between border-t border-border/50">
                  <Link
                    to={`/projects/${o.id}`}
                    className="text-xs font-semibold text-primary hover:underline flex items-center gap-1"
                  >
                    <span>Chi tiết</span>
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                  <button className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-red-500 transition-colors">
                    <Youtube className="w-4 h-4 text-red-500" />
                    <span>Tải lên YouTube</span>
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}