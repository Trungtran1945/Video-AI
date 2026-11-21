import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useMemo } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import QuotaBanner from '@/components/QuotaBanner';
import {
  LayoutDashboard, FolderPlus, FolderKanban, ListOrdered, Film,
  Settings, KeyRound, ScrollText, BarChart3, ShieldCheck,
  LogOut, Menu, Cpu, X, User, Clapperboard
} from 'lucide-react';

const navItems = [
  { label: 'Bảng điều khiển', path: '/dashboard', icon: LayoutDashboard },
  { label: 'Media Composer', path: '/composer', icon: Clapperboard },
  { label: 'Tạo dự án mới', path: '/projects/new', icon: FolderPlus },
  { label: 'Danh sách dự án', path: '/projects', icon: FolderKanban },
  { label: 'Hàng đợi xử lý', path: '/queue', icon: ListOrdered },
  { label: 'Đầu ra video', path: '/outputs', icon: Film },
  { label: 'Phân tích & Thống kê', path: '/analytics', icon: BarChart3 },
];

const settingsItems = [
  { label: 'Cài đặt chung', path: '/settings', icon: Settings },
  { label: 'Nhà cung cấp AI', path: '/settings/providers', icon: Cpu },
  { label: 'Quản lý khóa API', path: '/settings/api-keys', icon: KeyRound },
  { label: 'Nhật ký hệ thống', path: '/logs', icon: ScrollText },
];

const adminItems = [
  { label: 'Quản trị hệ thống', path: '/admin', icon: ShieldCheck },
];

const allRoutes = [...navItems, ...settingsItems, ...adminItems];

export default function Layout({ children }) {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { logout, user } = useAuth();

  const handleLogout = async () => {
    await logout();
    window.location.href = '/login';
  };

  const currentRoute = useMemo(() => {
    return allRoutes.find(r => r.path === location.pathname) || { label: 'Video AI' };
  }, [location.pathname]);

  const NavLink = ({ item }) => {
    const active = location.pathname === item.path;
    const Icon = item.icon;
    return (
      <Link
        to={item.path}
        onClick={() => setMobileOpen(false)}
        aria-current={active ? 'page' : undefined}
        className={`relative flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar ${
          active
            ? 'bg-sidebar-accent text-foreground font-medium'
            : 'text-sidebar-foreground/75 hover:text-foreground hover:bg-sidebar-accent/60'
        }`}
      >
        <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className="truncate">{item.label}</span>
        {active && (
          <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-primary" />
        )}
      </Link>
    );
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full w-[260px] bg-sidebar text-sidebar-foreground border-r border-sidebar-border select-none">
      {/* Brand logo */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-sidebar-border shrink-0">
        <Link to="/dashboard" className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-secondary border border-border/80 flex items-center justify-center text-primary">
            <Film className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="text-[13px] font-medium tracking-tight text-foreground leading-tight">AI Shorts Factory</div>
            <div className="text-[10px] text-muted-foreground font-mono">studio v1.0</div>
          </div>
        </Link>
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          aria-label="Đóng thanh điều hướng"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation sections */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
        <div>
          <div className="px-3 mb-1.5 text-[11px] font-medium text-muted-foreground/80">
            Tổng quan
          </div>
          <div className="space-y-0.5">
            {navItems.map(item => <NavLink key={item.path} item={item} />)}
          </div>
        </div>

        <div>
          <div className="px-3 mb-1.5 text-[11px] font-medium text-muted-foreground/80">
            Cấu hình
          </div>
          <div className="space-y-0.5">
            {settingsItems.map(item => <NavLink key={item.path} item={item} />)}
          </div>
        </div>

        {user?.role === 'admin' && (
        <div>
          <div className="px-3 mb-1.5 text-[11px] font-medium text-muted-foreground/80">
            Hệ thống
          </div>
          <div className="space-y-0.5">
            {adminItems.map(item => <NavLink key={item.path} item={item} />)}
          </div>
        </div>
        )}
      </div>

      {/* User profile & Logout */}
      <div className="p-3 border-t border-sidebar-border shrink-0 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-sidebar-accent/50 text-xs">
            <div className="w-7 h-7 rounded-md bg-primary/10 text-primary flex items-center justify-center font-bold">
              {user.email ? user.email[0].toUpperCase() : <User className="w-3.5 h-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate text-sidebar-foreground">{user.name || 'Người dùng'}</div>
              <div className="text-[10px] text-muted-foreground truncate">{user.email}</div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <ThemeToggle variant="quick" className="shrink-0" />
          <button
            onClick={handleLogout}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Đăng Xuất</span>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block shrink-0 h-full">
        <SidebarContent />
      </aside>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40 lg:hidden"
              aria-hidden="true"
            />
            <motion.div
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 350, damping: 35 }}
              className="fixed left-0 top-0 bottom-0 z-50 lg:hidden shadow-2xl"
            >
              <SidebarContent />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header Bar */}
        <header className="h-14 px-4 lg:px-8 border-b border-border bg-card/60 backdrop-blur-md flex items-center justify-between shrink-0 z-10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-1.5 rounded-md border border-border text-foreground hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Mở menu điều hướng"
            >
              <Menu className="w-4 h-4" />
            </button>
            <nav aria-label="Đường dẫn trang" className="hidden sm:flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Video AI Studio</span>
              <span className="text-muted-foreground/40">/</span>
              <span className="font-medium text-foreground">{currentRoute.label}</span>
            </nav>
            <div className="sm:hidden flex items-center gap-2">
              <Film className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-medium text-foreground">{currentRoute.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded border border-border/60 bg-secondary/60 text-[11px] font-mono text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
              <span>LIVE</span>
              <span className="text-border">|</span>
              <span className="text-foreground">REC 00:00:00</span>
            </div>
            <ThemeToggle />
          </div>
        </header>

        {/* Global API Quota Risk Banner */}
        <QuotaBanner />

        {/* Viewport content */}
        <main className="flex-1 overflow-y-auto min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}