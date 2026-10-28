import { useState, useEffect, useCallback } from 'react';
import { settingsApi, youtubeApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import ErrorState from '@/components/ErrorState';
import { ThemeToggle } from '@/components/ThemeToggle';
import { motion } from 'framer-motion';
import { Save, Loader2, Sliders, Moon, Check, Youtube } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [form, setForm] = useState({});
  const [ytAccount, setYtAccount] = useState(null);
  const [ytLoading, setYtLoading] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const s = await settingsApi.get();
      setSettings(s);
      setForm(s || {});
      youtubeApi.getAccount().then(setYtAccount).catch(() => setYtAccount(null));
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    setSavedSuccess(false);
    try {
      await settingsApi.update(form);
      setSavedSuccess(true);
      toast({
        title: 'Đã lưu cấu hình',
        description: 'Các cài đặt mặc định đã được cập nhật thành công.',
      });
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (e) {
      console.error(e);
      toast({
        variant: 'destructive',
        title: 'Lưu cài đặt thất bại',
        description: e?.response?.data?.message || e.message,
      });
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <Layout>
        <div className="p-6 lg:p-8 max-w-4xl mx-auto">
          <ErrorState status={loadError?.response?.status ?? 0} onRetry={load} />
        </div>
      </Layout>
    );
  }

  if (!settings) {
    return (
      <Layout>
        <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="text-sm">Đang tải cấu hình...</span>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
        <PageHeader
          title="Cài Đặt"
          subtitle="Cấu hình hệ thống và tùy chọn mặc định cho dự án mới"
          action={
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition shadow-xs disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : savedSuccess ? (
                <Check className="w-4 h-4 text-white" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              <span>{savedSuccess ? 'Đã lưu' : 'Lưu thay đổi'}</span>
            </button>
          }
        />

        {/* Appearance Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl bg-card border border-border p-6 shadow-xs"
        >
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Moon className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Giao Diện (Appearance)</h3>
              <p className="text-xs text-muted-foreground">Tùy chỉnh chế độ hiển thị Sáng / Tối theo sở thích</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg bg-muted/40 border border-border/60">
            <div>
              <div className="text-sm font-medium text-foreground">Chế độ giao diện</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Chuyển đổi giữa chế độ Sáng, Tối hoặc đồng bộ tự động theo hệ điều hành
              </div>
            </div>
            <ThemeToggle variant="segmented" />
          </div>
        </motion.div>

        {/* Project Defaults */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="rounded-xl bg-card border border-border p-6 shadow-xs"
        >
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Mặc Định Dự Án</h3>
              <p className="text-xs text-muted-foreground">Các tham số khởi tạo sẵn cho mỗi dự án mới</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Ngôn ngữ mặc định</label>
              <select
                value={form.default_language || 'vi'}
                onChange={e => update('default_language', e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <option value="vi">Tiếng Việt</option>
                <option value="en">Tiếng Anh</option>
                <option value="es">Tiếng Tây Ban Nha</option>
                <option value="fr">Tiếng Pháp</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Thời lượng mặc định (giây)</label>
              <input
                type="number"
                value={form.default_duration || 60}
                onChange={e => update('default_duration', parseInt(e.target.value) || 60)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Phong cách mặc định</label>
              <select
                value={form.default_style || 'cinematic'}
                onChange={e => update('default_style', e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <option value="cinematic">Điện ảnh (Cinematic)</option>
                <option value="anime">Anime</option>
                <option value="realistic">Tả thực (Realistic)</option>
                <option value="cartoon">Hoạt hình (Cartoon)</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Số lần thử lại tối đa (Retry)</label>
              <input
                type="number"
                min="0"
                max="10"
                value={form.max_retries || 3}
                onChange={e => update('max_retries', parseInt(e.target.value) || 3)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              />
            </div>
          </div>
        </motion.div>

        {/* NOTE: auto_upload_youtube / notify_on_complete đã gỡ khỏi UI — backend
            lưu trữ nhưng chưa có consumer (YouTube upload trả 501, notify luôn bắn
            qua pipeline bất kể flag). Giữ cột DB để tương thích, không persist-nhưng-không-ai-đọc. */}
              {/* YouTube OAuth Connection Section */}
        <div className="rounded-2xl bg-card border border-border p-6 shadow-sm space-y-4 text-left">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                <Youtube className="w-5 h-5 text-red-500" />
                Tài khoản YouTube
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Kết nối kênh YouTube để xuất bản video trực tiếp từ hệ thống
              </p>
            </div>
            {ytAccount?.connected ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <Check className="w-3.5 h-3.5" />
                Đã kết nối: {ytAccount.channelTitle}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Chưa kết nối</span>
            )}
          </div>
          {ytAccount?.connected ? (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-muted-foreground">Kênh ID: {ytAccount.channelId}</span>
              <button
                type="button"
                onClick={async () => {
                  setYtLoading(true);
                  try {
                    await youtubeApi.disconnectAccount();
                    setYtAccount({ connected: false });
                    toast({ title: 'Đã ngắt kết nối YouTube' });
                  } catch (err) {
                    toast({ variant: 'destructive', title: 'Lỗi ngắt kết nối', description: err?.response?.data?.message || err.message });
                  } finally {
                    setYtLoading(false);
                  }
                }}
                disabled={ytLoading}
                className="px-3 py-1.5 rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive text-xs font-medium transition"
              >
                {ytLoading ? 'Đang xử lý...' : 'Ngắt kết nối'}
              </button>
            </div>
          ) : (
            <div className="pt-2">
              <button
                type="button"
                onClick={async () => {
                  setYtLoading(true);
                  try {
                    const res = await youtubeApi.startOAuth();
                    if (res?.authorizationUrl) {
                      window.location.href = res.authorizationUrl;
                    }
                  } catch (err) {
                    toast({ variant: 'destructive', title: 'Lỗi kết nối YouTube', description: err?.response?.data?.message || err.message });
                  } finally {
                    setYtLoading(false);
                  }
                }}
                disabled={ytLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition"
              >
                <Youtube className="w-4 h-4" />
                <span>{ytLoading ? 'Đang chuẩn bị...' : 'Kết nối kênh YouTube'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}