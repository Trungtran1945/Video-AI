import { useState, useEffect } from 'react';
import { apiKeysApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { motion } from 'framer-motion';
import { KeyRound, Plus, Trash2, Eye, EyeOff, Zap, BarChart3, ShieldCheck } from 'lucide-react';

const providerLabels = {
  gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', huggingface: 'HuggingFace',
  elevenlabs: 'ElevenLabs', google_tts: 'Google TTS', azure_speech: 'Azure Speech',
  kling: 'Kling', hailuo: 'Hailuo', pixverse: 'PixVerse', runway: 'Runway', luma: 'Luma',
  flux: 'FLUX', stable_diffusion: 'Stable Diffusion',
  whisper: 'Whisper (OpenAI/Groq)', openai_whisper: 'Whisper API', youtube: 'YouTube',
};

const categories = ['llm', 'image', 'video', 'voice', 'subtitle', 'platform'];
const providers = Object.keys(providerLabels);

const TIER_OPTIONS = [
  { value: 'free', label: 'Free Tier', desc: 'Giới hạn RPM/quota thấp' },
  { value: 'paid', label: 'Paid Tier', desc: 'Không bị nghẽn rate limit' },
];

export default function ApiKeys() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState({});
  const [form, setForm] = useState({ provider: 'gemini', category: 'llm', api_key_encrypted: '', tier: 'free', priority: 0 });
  const [quotas, setQuotas] = useState({});

  useEffect(() => {
    (async () => {
      try {
        setKeys(await apiKeysApi.list() || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadQuota = async (provider) => {
    try {
      const q = await apiKeysApi.quota(provider);
      setQuotas(prev => ({ ...prev, [provider]: q }));
    } catch (_) {}
  };

  useEffect(() => {
    const pList = [...new Set(keys.map(k => k.provider))];
    pList.forEach(loadQuota);
  }, [keys]);

  const handleAdd = async () => {
    if (!form.api_key_encrypted.trim()) return;
    try {
      const created = await apiKeysApi.create(form.provider, form.category, form.api_key_encrypted, {
        tier: form.tier,
        priority: Number(form.priority),
      });
      setKeys([created, ...keys]);
      setShowAdd(false);
      setForm({ provider: 'gemini', category: 'llm', api_key_encrypted: '', tier: 'free', priority: 0 });
    } catch (e) {
      console.error(e);
      alert('Không thể thêm khóa: ' + (e.message || ''));
    }
  };

  const handleDelete = async (id) => {
    try {
      await apiKeysApi.remove(id);
      setKeys(keys.filter(k => k.id !== id));
    } catch (e) {
      console.error(e);
    }
  };

  const toggleActive = async (key) => {
    try {
      const updated = await apiKeysApi.toggle(key.id, !key.is_active);
      setKeys(keys.map(k => k.id === key.id ? { ...k, ...updated } : k));
    } catch (e) {
      console.error(e);
    }
  };

  const updateTier = async (key, tier) => {
    try {
      const updated = await apiKeysApi.update(key.id, { tier });
      setKeys(keys.map(k => k.id === key.id ? { ...k, ...updated } : k));
    } catch (e) {
      console.error(e);
    }
  };

  const updatePriority = async (key, priority) => {
    try {
      const updated = await apiKeysApi.update(key.id, { priority: Number(priority) });
      setKeys(keys.map(k => k.id === key.id ? { ...k, ...updated } : k));
    } catch (e) {
      console.error(e);
    }
  };

  const maskKey = (k) => k ? k.slice(0, 4) + '••••••••' + k.slice(-4) : '—';

  const QuotaBar = ({ provider }) => {
    const q = quotas[provider];
    if (!q || q.limitToday === null) return null;
    const pct = Math.min(q.percentUsed || 0, 100);
    const isHigh = pct >= 80;
    return (
      <div className="flex items-center gap-2 mt-2">
        <BarChart3 className={`w-3.5 h-3.5 ${isHigh ? 'text-amber-500' : 'text-muted-foreground'}`} />
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isHigh ? 'bg-amber-500' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[11px] text-muted-foreground font-medium">{q.usedToday}/{q.limitToday}</span>
      </div>
    );
  };

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
        <PageHeader
          title="Khóa API"
          subtitle={`${keys.length} khóa nhà cung cấp được lưu mã hóa an toàn`}
          action={
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <Plus className="w-4 h-4" />
              <span>Thêm Khóa Mới</span>
            </button>
          }
        />

        {showAdd && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="rounded-xl bg-card border border-primary/30 p-6 shadow-sm overflow-hidden"
          >
            <div className="flex items-center gap-2 mb-4 text-primary font-semibold text-sm">
              <ShieldCheck className="w-4 h-4" />
              <span>Thêm khóa API mới</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-3.5">
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Nhà cung cấp</label>
                <select
                  value={form.provider}
                  onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {providers.map(p => <option key={p} value={p}>{providerLabels[p]}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Phân loại (Category)</label>
                <select
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {categories.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
            </div>

            <div className="mb-3.5">
              <label className="block text-xs font-semibold text-foreground mb-1.5">Giá trị API Key</label>
              <input
                type="password"
                value={form.api_key_encrypted}
                onChange={e => setForm(f => ({ ...f, api_key_encrypted: e.target.value }))}
                placeholder="sk-... hoặc dán mã khóa vào đây"
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 font-mono"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-5">
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Gói tài khoản (Tier)</label>
                <select
                  value={form.tier}
                  onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {TIER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-foreground mb-1.5">Ưu tiên luân chuyển (0 = mặc định)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                />
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                onClick={handleAdd}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                Lưu Khóa
              </button>
              <button
                onClick={() => setShowAdd(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                Hủy
              </button>
            </div>
          </motion.div>
        )}

        {loading ? (
          <Loading />
        ) : keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="Chưa lưu khóa API nào"
            description="Thêm khóa API cho các dịch vụ AI như Gemini, OpenAI, ElevenLabs để bắt đầu xử lý kịch bản, video và giọng nói."
          />
        ) : (
          <div className="space-y-3">
            {keys.map((k, i) => (
              <motion.div
                key={k.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 sm:p-5 rounded-xl bg-card border border-border shadow-xs hover:border-primary/30 transition-all"
              >
                <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <KeyRound className="w-5 h-5" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-foreground">{providerLabels[k.provider] || k.provider}</span>
                    <span className="px-2 py-0.5 rounded-md bg-muted text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {k.label || k.provider}
                    </span>
                    {k.tier === 'free' && (
                      <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-[10px] font-semibold text-amber-700 dark:text-amber-400 border border-amber-500/20 flex items-center gap-1">
                        <Zap className="w-2.5 h-2.5" /> Free Tier
                      </span>
                    )}
                    {k.priority > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-[10px] font-semibold text-primary border border-blue-500/20">
                        Priority {k.priority}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mt-1.5">
                    <code className="text-xs text-muted-foreground font-mono bg-muted/40 px-2 py-0.5 rounded border border-border/60">
                      {visibleKeys[k.id] ? (k.keyPreview || '—') : maskKey(k.keyPreview || '')}
                    </code>
                    <button
                      type="button"
                      onClick={() => setVisibleKeys(v => ({ ...v, [k.id]: !v[k.id] }))}
                      className="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors"
                      title={visibleKeys[k.id] ? "Ẩn khóa" : "Hiện khóa"}
                    >
                      {visibleKeys[k.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <QuotaBar provider={k.provider} />
                </div>

                <div className="flex items-center gap-3 self-end sm:self-center shrink-0">
                  <div className="flex flex-col items-end gap-1.5">
                    <select
                      value={k.tier || 'free'}
                      onChange={e => updateTier(k, e.target.value)}
                      className="px-2.5 py-1 rounded-lg bg-background border border-input text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                    >
                      {TIER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={k.priority ?? 0}
                      onChange={e => updatePriority(k, e.target.value)}
                      title="Mức ưu tiên"
                      className="w-16 px-2 py-0.5 rounded-lg bg-background border border-input text-xs text-foreground text-center focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>

                  {/* Toggle active switch */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(k.is_active)}
                    onClick={() => toggleActive(k)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      k.is_active ? 'bg-emerald-600' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                        k.is_active ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDelete(k.id)}
                    className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                    title="Xóa khóa"
                  >
                    <Trash2 className="w-4 h-4" />
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
