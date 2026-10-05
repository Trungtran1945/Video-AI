import { useState, useEffect } from 'react';
import { outputsApi } from '@/api/outputs';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Film, Play, Youtube, Search, ArrowRight, AlertTriangle, Loader2 } from 'lucide-react';
import { formatDate, MODE_LABELS } from '@/lib/constants';
import { useToast } from '@/components/ui/use-toast';

export default function Outputs() {
  const [loading, setLoading] = useState(true);
  const [outputs, setOutputs] = useState([]);
  const [search, setSearch] = useState('');
  const [uploadingYoutubeId, setUploadingYoutubeId] = useState(null);
  const { toast } = useToast();

  useEffect(() => {
    (async () => {
      try {
        const outData = await outputsApi.list().catch(() => []);
        if (Array.isArray(outData) && outData.length > 0) {
          setOutputs(outData);
        } else {
          // Fallback to completed projects if outputs table is empty
          const pData = await projectsApi.list().catch(() => []);
          const completed = (pData || [])
            .filter((p) => p.status === 'completed' && p.output?.storage_key)
            .map((p) => ({
              id: p.output?.id || p.id,
              project_id: p.id,
              project_title: p.title,
              title: p.title,
              language: p.language,
              mode: p.mode,
              storage_key: p.output?.storage_key,
              duration_sec: p.target_duration_sec,
              outputStale: p.outputStale,
              created_date: p.output?.created_date || p.created_date,
            }));
          setOutputs(completed);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleUploadYoutube = async (output) => {
    if (uploadingYoutubeId) return;
    setUploadingYoutubeId(output.id);
    try {
      const res = await outputsApi.youtube(output.id, 'private');
      toast({
        title: 'Đã xếp hàng tải lên YouTube',
        description: res?.message || 'Yêu cầu tải lên đang được xử lý ở chế độ Riêng tư (Private).',
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Lỗi tải lên YouTube',
        description: err?.response?.data?.message || err.message,
      });
    } finally {
      setUploadingYoutubeId(null);
    }
  };

  const filtered = (outputs || []).filter(o => {
    const title = o.project_title || o.title || '';
    return title.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Đầu Ra Video"
          subtitle={`${outputs.length} video đã hoàn thành và sẵn sàng xuất bản`}
        />

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm kiếm video thành phẩm..."
            className="w-full pl-9 pr-4 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((o, i) => {
              const projectId = o.project_id || o.id;
              const title = o.project_title || o.title;
              const isUploading = uploadingYoutubeId === o.id;
              const isStale = Boolean(o.outputStale);

              return (
                <motion.div
                  key={o.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03, duration: 0.2 }}
                  className="rounded-xl bg-card border border-border overflow-hidden group hover:border-border/90 hover:shadow-xs transition-colors flex flex-col justify-between"
                >
                  <div>
                    <div className="relative aspect-video bg-muted flex items-center justify-center overflow-hidden">
                      <Film className="w-8 h-8 text-muted-foreground/50 group-hover:scale-105 transition-transform duration-200" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Link
                          to={`/projects/${projectId}`}
                          className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-md transform scale-90 group-hover:scale-100 transition-transform focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Mở video ${title}`}
                        >
                          <Play className="w-4 h-4 fill-current ml-0.5" />
                        </Link>
                      </div>

                      {/* Stale Badge */}
                      {isStale && (
                        <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-amber-500/90 text-[10px] font-semibold text-white shadow-xs flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Cần xuất lại
                        </span>
                      )}

                      {o.duration_sec && (
                        <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/75 text-[10px] font-mono font-semibold text-white tracking-wide">
                          {Math.round(o.duration_sec)}s
                        </span>
                      )}
                    </div>

                    <div className="p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-semibold">
                          {MODE_LABELS[o.mode] || o.mode || 'Video'}
                        </span>
                      </div>
                      <h3 className="font-semibold text-foreground text-sm sm:text-base truncate group-hover:text-primary transition-colors">
                        {title}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-1 font-medium">
                        <span className="font-mono">{formatDate(o.created_date)}</span>
                      </p>
                    </div>
                  </div>

                  <div className="px-4 pb-3.5 pt-2 flex items-center justify-between border-t border-border/50">
                    <Link
                      to={`/projects/${projectId}`}
                      className="text-xs font-semibold text-primary hover:underline flex items-center gap-1 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring rounded"
                    >
                      <span>Chi tiết</span>
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                    <button
                      type="button"
                      disabled={isUploading}
                      onClick={() => handleUploadYoutube(o)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-red-500 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring rounded px-1.5 py-0.5 disabled:opacity-50"
                    >
                      {isUploading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-red-500" />
                      ) : (
                        <Youtube className="w-3.5 h-3.5 text-red-500" />
                      )}
                      <span>{isUploading ? 'Đang gửi...' : 'Tải lên YouTube'}</span>
                    </button>
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