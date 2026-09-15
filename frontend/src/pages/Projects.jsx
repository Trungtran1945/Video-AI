import { useState, useEffect } from 'react';
import { projectsApi } from '@/api/projects';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Film, Languages, Plus, Search, Trash2 } from 'lucide-react';
import { StatusBadge, formatDate, LANGUAGE_LABELS, STYLE_LABELS, MODE_LABELS } from '@/lib/constants';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/use-toast';

export default function Projects() {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [search, setSearch] = useState('');
  const [modeFilter, setModeFilter] = useState('ALL'); // 'ALL' | 'SUMMARY' | 'TRANSLATE_DUB'
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    (async () => {
      try {
        const data = await projectsApi.list();
        setProjects(data || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await projectsApi.remove(deleteTarget.id);
      setProjects((prev) => prev.filter((x) => x.id !== deleteTarget.id));
      toast({
        title: 'Đã xoá dự án',
        description: `“${deleteTarget.title}” và các tệp liên quan đã được xoá khỏi kho lưu trữ.`,
      });
      setDeleteTarget(null);
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Không thể xoá dự án',
        description: e?.response?.data?.message || e.message,
      });
    } finally {
      setDeleting(false);
    }
  };

  const filtered = (projects || []).filter(p => {
    if (modeFilter !== 'ALL' && p.mode !== modeFilter) return false;
    return p.title?.toLowerCase().includes(search.toLowerCase());
  });

  const isDubMode = (m) => m === 'TRANSLATE_DUB' || m === 'translate_dub';

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
        <PageHeader
          title="Dự Án"
          subtitle={`${projects.length} dự án trong kho lưu trữ`}
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

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Tìm dự án theo tên hoặc chủ đề..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center gap-1 rounded-xl bg-card border border-border p-1">
            {[
              { key: 'ALL', label: 'Tất cả' },
              { key: 'SUMMARY', label: MODE_LABELS.SUMMARY },
              { key: 'TRANSLATE_DUB', label: MODE_LABELS.TRANSLATE_DUB },
            ].map((m) => (
              <button
                key={m.key}
                onClick={() => setModeFilter(m.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  modeFilter === m.key
                    ? 'bg-primary text-primary-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* List / Cards */}
        {loading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Film}
            title={search ? 'Không tìm thấy dự án phù hợp' : 'Chưa có dự án nào'}
            description={
              search
                ? 'Thử tìm với từ khóa khác hoặc xóa bộ lọc để xem toàn bộ danh sách.'
                : 'Tạo dự án đầu tiên để bắt đầu quy trình biên tập và sản xuất video tự động.'
            }
            action={
              <Link
                to="/projects/new"
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition shadow-md shadow-primary/20"
              >
                <Plus className="w-4 h-4" />
                <span>Tạo Dự Án</span>
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filtered.map((p, i) => (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <div className="relative rounded-2xl bg-card border border-border hover:border-primary/40 p-5 transition-all hover:shadow-md group flex flex-col justify-between h-full">
                  <Link
                    to={`/projects/${p.id}`}
                    className="absolute inset-0 z-0 rounded-2xl"
                    aria-label={`Mở dự án ${p.title}`}
                  >
                    <span className="sr-only">{p.title}</span>
                  </Link>

                  <div>
                    <div className="flex items-start justify-between mb-3.5">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                        {isDubMode(p.mode) ? <Languages className="w-5 h-5" /> : <Film className="w-5 h-5" />}
                      </div>
                      <div className="relative z-10 flex items-center gap-1.5">
                        <StatusBadge status={p.status} />
                        <button
                          onClick={() => setDeleteTarget(p)}
                          aria-label={`Xoá dự án ${p.title}`}
                          title="Xoá dự án"
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <h3 className="font-bold text-foreground text-base truncate group-hover:text-primary transition-colors">
                      {p.title}
                    </h3>

                    <div className="flex flex-wrap gap-1.5 mt-3">
                      <span className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-medium text-foreground">
                        {MODE_LABELS[p.mode] || p.mode}
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-medium text-muted-foreground">
                        {LANGUAGE_LABELS[p.language] || p.language}
                      </span>
                      {isDubMode(p.mode) ? (
                        <span className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-medium text-muted-foreground">
                          {p.params?.stylePreset || p.params?.style_preset || '—'}
                        </span>
                      ) : (
                        <>
                          <span className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-medium text-muted-foreground">
                            {STYLE_LABELS[p.style] || p.style}
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-medium text-muted-foreground">
                            {p.target_duration_sec}s
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 pt-3 border-t border-border/60">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5 font-medium">
                      <span>Tiến độ hoàn thành</span>
                      <span>{p.progress || 0}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all"
                        style={{ width: `${p.progress || 0}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-3 font-medium">
                      {formatDate(p.created_date)}
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground text-lg">Xoá dự án này?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground text-sm">
              Dự án “{deleteTarget?.title}” cùng video nguồn, giọng đọc, phụ đề và video render sẽ bị xoá vĩnh viễn khỏi kho lưu trữ. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              Huỷ
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={deleting}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-semibold"
            >
              {deleting ? 'Đang xoá...' : 'Xoá vĩnh viễn'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}