import { useState, useEffect } from 'react';
import { settingsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import { ThemeToggle } from '@/components/ThemeToggle';
import { motion } from 'framer-motion';
import { Save, Loader2, Sliders, Moon, Check, Bell, Youtube } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [form, setForm] = useState({});
  const { toast } = useToast();

  useEffect(() => {
    (async () => {
      try {
        const s = await settingsApi.get();
        setSettings(s);
        setForm(s || {});
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

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

  const Toggle = ({ value, onChange, label, description, icon: Icon }) => (
    <div className="flex items-center justify-between py-4 border-b border-border/60 last:border-0">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-muted-foreground shrink-0">
            <Icon className="w-4 h-4" />
          </div>
        )}
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(value)}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          value ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
            value ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );

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
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition-all shadow-md shadow-primary/20 disabled:opacity-50"
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
          className="rounded-2xl bg-card border border-border p-6 shadow-sm"
        >
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Moon className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Giao Diện (Appearance)</h3>
              <p className="text-xs text-muted-foreground">Tùy chỉnh chế độ hiển thị Sáng / Tối theo sở thích</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-muted/40 border border-border/60">
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
          className="rounded-2xl bg-card border border-border p-6 shadow-sm"
        >
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
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
                className="w-full px-3.5 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
                className="w-full px-3.5 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Phong cách mặc định</label>
              <select
                value={form.default_style || 'cinematic'}
                onChange={e => update('default_style', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
                className="w-full px-3.5 py-2.5 rounded-xl bg-background border border-input text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        </motion.div>

        {/* General Options */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-2xl bg-card border border-border p-6 shadow-sm"
        >
          <h3 className="text-sm font-semibold text-foreground mb-2">Tùy Chọn Mở Rộng</h3>
          <div className="divide-y divide-border/60">
            <Toggle
              icon={Youtube}
              label="Tự động tải lên YouTube"
              description="Tự động đồng bộ video đầu ra lên kênh YouTube khi xuất xong"
              value={form.auto_upload_youtube || false}
              onChange={v => update('auto_upload_youtube', v)}
            />
            <Toggle
              icon={Bell}
              label="Thông báo khi hoàn thành"
              description="Hiển thị thông báo trình duyệt và cập nhật thời gian thực khi pipeline hoàn tất"
              value={form.notify_on_complete !== false}
              onChange={v => update('notify_on_complete', v)}
            />
          </div>
        </motion.div>
      </div>
    </Layout>
  );
}