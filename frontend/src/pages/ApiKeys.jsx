import { useState, useEffect } from 'react';
import { apiKeysApi } from '@/api/extra';
import Layout from '@/components/Layout';
import PageHeader from '@/components/PageHeader';
import Loading from '@/components/Loading';
import EmptyState from '@/components/EmptyState';
import { motion } from 'framer-motion';
import { KeyRound, Plus, Trash2, Eye, EyeOff, Zap, BarChart3 } from 'lucide-react';

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
  { value: 'free', label: 'Free', desc: 'API key miễn phí, bị giới hạn RPM/quota' },
  { value: 'paid', label: 'Paid', desc: 'API key trả phí, không bị rate limit' },
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
      try { setKeys(await apiKeysApi.list() || []); }
      catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  const loadQuota = async (provider) => {
    try {
      const q = await apiKeysApi.quota(provider);
      setQuotas(prev => ({ ...prev, [provider]: q }));
    } catch (_) {}
  };

  useEffect(() => {
    const providers = [...new Set(keys.map(k => k.provider))];
    providers.forEach(loadQuota);
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
    } catch (e) { console.error(e); alert('Không thể thêm khóa: ' + (e.message || '')); }
  };

  const handleDelete = async (id) => {
    try {
      await apiKeysApi.remove(id);
      setKeys(keys.filter(k => k.id !== id));
    } catch (e) { console.error(e); }
  };

  const toggleActive = async (key) => {
    try {
      const updated = await apiKeysApi.toggle(key.id, !key.is_active);
      setKeys(keys.map(k => k.id === key.id ? { ...k, ...updated } : k));
    } catch (e) { console.error(e); }
  };

  const updateTier = async (key, tier) => {
    try {
      const updated = await apiKeysApi.update(key.id, { tier });
      setKeys(keys.map(k => k.id === key.id ? { ...k, ...updated } : k));
    } catch (e) { console.error(e); }
  };

  const updatePriority = async (key, priority) => {
    try {
      const updated = await apiKeysApi.update(key.id, { priority: Number(priority) });
      setKeys(keys.map(k => k.id === key.id ? { ...k, ...updated } : k));
    } catch (e) { console.error(e); }
  };

  const maskKey = (k) => k ? k.slice(0, 4) + '••••••••' + k.slice(-4) : '—';

  const QuotaBar = ({ provider }) => {
    const q = quotas[provider];
    if (!q || q.limitToday === null) return null;
    const pct = Math.min(q.percentUsed || 0, 100);
    const isHigh = pct >= 80;
    return (
      <div className="flex items-center gap-2 mt-1.5">
        <BarChart3 className={`w-3 h-3 ${isHigh ? 'text-amber-400' : 'text-slate-500'}`} />
        <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${isHigh ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] text-slate-500">{q.usedToday}/{q.limitToday}</span>
      </div>
    );
  };

  return (
    <Layout>
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <PageHeader
          title="Khóa API"
          subtitle={`${keys.length} khóa đã lưu`}
          action={
            <button onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition">
              <Plus className="w-4 h-4" /> Thêm khóa
            </button>
          }
        />

        {showAdd && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            className="rounded-2xl bg-[#161922] border border-blue-500/20 p-5 mb-4 overflow-hidden">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                className="px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50">
                {providers.map(p => <option key={p} value={p}>{providerLabels[p]}</option>)}
              </select>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50">
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <input type="password" value={form.api_key_encrypted} onChange={e => setForm(f => ({ ...f, api_key_encrypted: e.target.value }))}
              placeholder="Dán khóa API vào đây..."
              className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50 mb-3" />
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Tier</label>
                <select value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50">
                  {TIER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Ưu tiên (0 = thấp nhất)</label>
                <input type="number" min="0" max="100" value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50" />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleAdd} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition">Lưu khóa</button>
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition">Hủy</button>
            </div>
          </motion.div>
        )}

        {loading ? <Loading /> : keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="Chưa có khóa API nào" description="Thêm khóa API cho các nhà cung cấp để kích hoạt pipeline AI." />
        ) : (
          <div className="space-y-2">
            {keys.map((k, i) => (
              <motion.div key={k.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                className="flex items-center gap-4 p-4 rounded-xl bg-[#161922] border border-white/5">
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                  <KeyRound className="w-4 h-4 text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">{providerLabels[k.provider] || k.provider}</span>
                    <span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px] text-slate-400 uppercase">{k.label || k.provider}</span>
                    {k.tier === 'free' && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-[10px] text-amber-400 flex items-center gap-0.5">
                        <Zap className="w-2.5 h-2.5" /> Free
                      </span>
                    )}
                    {k.priority > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-[10px] text-blue-400">
                        P{k.priority}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-xs text-slate-500 font-mono">
                      {visibleKeys[k.id] ? (k.keyPreview || '—') : maskKey(k.keyPreview || '')}
                    </code>
                    <button onClick={() => setVisibleKeys(v => ({ ...v, [k.id]: !v[k.id] }))} className="text-slate-500 hover:text-slate-300">
                      {visibleKeys[k.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                  <QuotaBar provider={k.provider} />
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <select value={k.tier || 'free'} onChange={e => updateTier(k, e.target.value)}
                    className="px-2 py-1 rounded-lg bg-[#0F1117] border border-white/5 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/50 cursor-pointer">
                    {TIER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <input type="number" min="0" max="100" value={k.priority ?? 0}
                    onChange={e => updatePriority(k, e.target.value)}
                    className="w-14 px-2 py-1 rounded-lg bg-[#0F1117] border border-white/5 text-[11px] text-slate-300 text-center focus:outline-none focus:border-blue-500/50" />
                </div>
                <button onClick={() => toggleActive(k)}
                  className={`relative w-11 h-6 rounded-full transition ${k.is_active ? 'bg-emerald-600' : 'bg-white/10'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${k.is_active ? 'translate-x-5' : ''}`} />
                </button>
                <button onClick={() => handleDelete(k.id)} className="text-slate-500 hover:text-red-400 transition">
                  <Trash2 className="w-4 h-4" />
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
