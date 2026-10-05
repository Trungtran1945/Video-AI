import { useState, useEffect, useCallback, useRef } from 'react';
import { apiKeysApi } from '@/api/extra';
import { AlertTriangle, X, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';

const POLL_INTERVAL_MS = 60000;
const PROBE_PROVIDERS = ['gemini', 'openai', 'elevenlabs'];

export default function QuotaBanner() {
  const [atRiskProviders, setAtRiskProviders] = useState([]);
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);

  const checkQuotas = useCallback(async () => {
    try {
      // 1. Fetch user's keys to know their configured providers
      let userProviders = [];
      try {
        const keys = await apiKeysApi.list();
        if (Array.isArray(keys)) {
          userProviders = keys.map((k) => k.provider).filter(Boolean);
        }
      } catch {
        // Fallback to default providers if list fails
      }

      const allProviders = Array.from(new Set([...PROBE_PROVIDERS, ...userProviders]));
      const risks = [];

      await Promise.all(
        allProviders.map(async (provider) => {
          try {
            const q = await apiKeysApi.quota(provider);
            const percent = Number(q?.percentUsed || 0);
            if (percent >= 80) {
              risks.push({
                provider,
                percentUsed: percent,
                usedToday: q.usedToday,
                limitToday: q.limitToday,
                usedThisMinute: q.usedThisMinute,
                limitThisMinute: q.limitThisMinute,
              });
            }
          } catch {
            // Ignore individual provider quota fetch errors
          }
        })
      );

      if (mountedRef.current) {
        setAtRiskProviders(risks);
      }
    } catch {
      // Best-effort check
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    checkQuotas();
    const interval = setInterval(checkQuotas, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [checkQuotas]);

  if (dismissed || atRiskProviders.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="shrink-0 bg-amber-500/10 border-b border-amber-500/25 px-4 py-2 text-xs text-amber-600 dark:text-amber-400 select-none z-20"
      >
        <div className="flex items-center justify-between gap-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="p-1 rounded-md bg-amber-500/20 text-amber-500 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">
                Sắp chạm giới hạn API — có thể chậm hơn dự kiến
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {atRiskProviders.map((risk) => (
                  <span
                    key={risk.provider}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono text-[11px] font-medium"
                  >
                    <span className="capitalize">{risk.provider}</span>: {risk.percentUsed.toFixed(0)}%
                    {risk.limitToday != null && ` (${risk.usedToday}/${risk.limitToday})`}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/settings/api-keys"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:text-foreground hover:underline transition-colors"
            >
              <span>Quản lý Khóa API</span>
              <ChevronRight className="w-3 h-3" />
            </Link>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="p-1 rounded-md text-amber-600/70 hover:text-foreground hover:bg-amber-500/20 transition-colors"
              title="Tạm ẩn cảnh báo"
              aria-label="Đóng cảnh báo"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
