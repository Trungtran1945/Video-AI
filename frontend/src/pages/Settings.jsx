import { useState, useEffect } from 'react';
import { settingsApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import { motion } from 'framer-motion';
import { Save, Loader2 } from 'lucide-react';

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const s = await settingsApi.get();
        setSettings(s);
        setForm(s || {});
      } catch (e) { console.error(e); }
    })();
  }, []);

  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await settingsApi.update(form);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const Toggle = ({ value, onChange }) => (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition ${value ? 'bg-blue-600' : 'bg-white/10'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : ''}`} />
    </button>
  );

  const Field = ({ label, children }) => (
    <div className="flex items-center justify-between py-3 border-b border-white/5 last:border-0">
      <div>
        <div className="text-sm font-medium text-slate-200">{label}</div>
      </div>
      {children}
    </div>
  );

  if (!settings) return <Layout><div className="p-8 text-center text-slate-400">Đang tải...</div></Layout>;

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <PageHeader
          title="Cài Đặt"
          subtitle="Cấu hình mặc định cho dự án mới"
          action={
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Lưu
            </button>
          }
        />

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl bg-[#161922] border border-white/5 p-6 mb-6">
          <h3 className="text-sm font-semibold text-white mb-4">Mặc định dự án</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">Ngôn ngữ mặc định</label>
              <select value={form.default_language || 'vi'} onChange={e => update('default_language', e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50">
                <option value="vi">Tiếng Việt</option><option value="en">Tiếng Anh</option>
                <option value="es">Tiếng Tây Ban Nha</option><option value="fr">Tiếng Pháp</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">Thời lượng mặc định (giây)</label>
              <input type="number" value={form.default_duration || 60} onChange={e => update('default_duration', parseInt(e.target.value) || 60)}
                className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">Phong cách mặc định</label>
              <select value={form.default_style || 'cinematic'} onChange={e => update('default_style', e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50">
                <option value="cinematic">Điện ảnh</option><option value="anime">Anime</option>
                <option value="realistic">Tả thực</option><option value="cartoon">Hoạt hình</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">Số lần thử lại tối đa</label>
              <input type="number" value={form.max_retries || 3} onChange={e => update('max_retries', parseInt(e.target.value) || 3)}
                className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50" />
            </div>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="rounded-2xl bg-[#161922] border border-white/5 p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Tùy chọn</h3>
          <Field label="Tự động tải lên YouTube">
            <Toggle value={form.auto_upload_youtube || false} onChange={v => update('auto_upload_youtube', v)} />
          </Field>
          <Field label="Thông báo khi hoàn thành">
            <Toggle value={form.notify_on_complete !== false} onChange={v => update('notify_on_complete', v)} />
          </Field>
        </motion.div>
      </div>
    </Layout>
  );
}