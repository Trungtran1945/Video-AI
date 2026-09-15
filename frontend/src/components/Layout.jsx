import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useMemo } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  LayoutDashboard, FolderPlus, FolderKanban, ListOrdered, Film,
  Settings, KeyRound, ScrollText, BarChart3, ShieldCheck, Sparkles,
  LogOut, Menu, Cpu, X, User
} from 'lucide-react';

const navItems = [
  { label: 'Bảng Điều Khiển', path: '/dashboard', icon: LayoutDashboard },
  { label: 'Tạo Dự Án', path: '/projects/new', icon: FolderPlus },
  { label: 'Dự Án', path: '/projects', icon: FolderKanban },
  { label: 'Hàng Đợi Tạo', path: '/queue', icon: ListOrdered },
  { label: 'Đầu Ra', path: '/outputs', icon: Film },
  { label: 'Phân Tích', path: '/analytics', icon: BarChart3 },
];

const settingsItems = [
  { label: 'Cài Đặt', path: '/settings', icon: Settings },
  { label: 'Nhà Cung Cấp', path: '/settings/providers', icon: Cpu },
  { label: 'Khóa API', path: '/settings/api-keys', icon: KeyRound },
  { label: 'Nhật Ký', path: '/logs', icon: ScrollText },
];

const adminItems = [
  { label: 'Bảng Admin', path: '/admin', icon: ShieldCheck },
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
        className={`relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
          active
            ? 'bg-primary/10 text-primary font-semibold shadow-xs'
            : 'text-sidebar-foreground/75 hover:text-sidebar-foreground hover:bg-sidebar-accent'
        }`}
      >
        <Icon className={`w-[18px] h-[18px] shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className="truncate">{item.label}</span>
        {active && (
          <motion.div
            layoutId="sidebarActiveIndicator"
            className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-primary"
          />
        )}
      </Link>
    );
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full w-[268px] bg-sidebar text-sidebar-foreground border-r border-sidebar-border select-none">
      {/* Brand logo */}
      <div className="flex items-center justify-between px-5 h-16 border-b border-sidebar-border shrink-0">
        <Link to="/dashboard" className="flex items-center gap-3 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/20 group-hover:scale-105 transition-transform">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-sidebar-foreground leading-tight">AI Shorts</div>
            <div className="text-[10px] text-primary font-semibold tracking-wider uppercase">Factory Studio</div>
          </div>
        </Link>
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-sidebar-accent"
          aria-label="Đóng thanh điều hướng"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Navigation sections */}
      <div className="flex-1 overflow-y-auto px-3.5 py-4 space-y-6">
        <div>
          <div className="px-3 mb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Tổng Quan
          </div>
          <div className="space-y-1">
            {navItems.map(item => <NavLink key={item.path} item={item} />)}
          </div>
        </div>

        <div>
          <div className="px-3 mb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Cấu Hình
          </div>
          <div className="space-y-1">
            {settingsItems.map(item => <NavLink key={item.path} item={item} />)}
          </div>
        </div>

        <div>
          <div className="px-3 mb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Hệ Thống
          </div>
          <div className="space-y-1">
            {adminItems.map(item => <NavLink key={item.path} item={item} />)}
          </div>
        </div>
      </div>

      {/* User profile & Logout */}
      <div className="p-3 border-t border-sidebar-border shrink-0 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-sidebar-accent/50 text-xs">
            <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold">
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
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
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
        <header className="h-16 px-4 lg:px-8 border-b border-border bg-card/60 backdrop-blur-md flex items-center justify-between shrink-0 z-10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-xl border border-border text-foreground hover:bg-accent"
              aria-label="Mở menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="hidden sm:block">
              <span className="text-xs text-muted-foreground">AI Shorts Studio</span>
              <span className="text-xs text-muted-foreground mx-2">/</span>
              <span className="text-sm font-semibold text-foreground">{currentRoute.label}</span>
            </div>
            <div className="sm:hidden flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-bold text-foreground">{currentRoute.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <ThemeToggle />
          </div>
        </header>

        {/* Viewport content */}
        <main className="flex-1 overflow-y-auto min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}