import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle({ variant = 'dropdown', className = '' }) {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme, resolvedTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        className={`w-9 h-9 rounded-xl border border-border/60 bg-card/60 flex items-center justify-center text-muted-foreground ${className}`}
        aria-hidden="true"
      >
        <span className="w-4 h-4 rounded-full bg-muted animate-pulse" />
      </div>
    );
  }

  // Segmented control style (used in Settings)
  if (variant === 'segmented') {
    return (
      <div
        role="radiogroup"
        aria-label="Chọn giao diện"
        className={`inline-flex items-center p-1 rounded-xl bg-muted/60 border border-border/80 ${className}`}
      >
        {[
          { key: 'light', label: 'Sáng', icon: Sun },
          { key: 'dark', label: 'Tối', icon: Moon },
          { key: 'system', label: 'Hệ thống', icon: Monitor },
        ].map((item) => {
          const active = theme === item.key;
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(item.key)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Quick toggle (cycles light -> dark -> light)
  if (variant === 'quick') {
    const isDark = resolvedTheme === 'dark';
    return (
      <button
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        aria-label={isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
        title={isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
        className={`w-9 h-9 rounded-xl border border-border/80 bg-card/80 hover:bg-accent text-foreground flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      >
        {isDark ? (
          <Sun className="w-4 h-4 text-amber-400 transition-transform rotate-0 scale-100" />
        ) : (
          <Moon className="w-4 h-4 text-indigo-500 transition-transform rotate-0 scale-100" />
        )}
      </button>
    );
  }

  // Default dropdown variant with accessible labels
  const isDark = resolvedTheme === 'dark';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Thay đổi giao diện"
          title="Thay đổi giao diện"
          className={`w-9 h-9 rounded-xl border border-border/80 bg-card/80 hover:bg-accent text-foreground flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
        >
          {isDark ? (
            <Moon className="w-4 h-4 text-indigo-400" />
          ) : (
            <Sun className="w-4 h-4 text-amber-500" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem
          onClick={() => setTheme('light')}
          className={`flex items-center gap-2 text-xs font-medium cursor-pointer ${
            theme === 'light' ? 'text-primary font-semibold' : ''
          }`}
        >
          <Sun className="w-4 h-4 text-amber-500" />
          <span>Sáng</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme('dark')}
          className={`flex items-center gap-2 text-xs font-medium cursor-pointer ${
            theme === 'dark' ? 'text-primary font-semibold' : ''
          }`}
        >
          <Moon className="w-4 h-4 text-indigo-400" />
          <span>Tối</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme('system')}
          className={`flex items-center gap-2 text-xs font-medium cursor-pointer ${
            theme === 'system' ? 'text-primary font-semibold' : ''
          }`}
        >
          <Monitor className="w-4 h-4 text-muted-foreground" />
          <span>Hệ thống</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ThemeToggle;
