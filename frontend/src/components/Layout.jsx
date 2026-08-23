import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import {
  LayoutDashboard, FolderPlus, FolderKanban, ListOrdered, Film,
  Settings, KeyRound, ScrollText, BarChart3, ShieldCheck, Sparkles,
  LogOut, Menu, Cpu
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

export default function Layout({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { logout } = useAuth();
  const handleLogout = async () => {
    await logout();
    window.location.href = '/login';
  };

  const NavLink = ({ item }) => {
    const active = location.pathname === item.path;
    return (
      <Link
        to={item.path}
        onClick={() => setMobileOpen(false)}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
          active
            ? 'bg-blue-600/15 text-blue-400'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
        }`}
      >
        <item.icon className="w-[18px] h-[18px] shrink-0" />
        <span>{item.label}</span>
        {active && (
          <motion.div
            layoutId="navIndicator"
            className="absolute left-0 w-1 h-6 rounded-r-full bg-blue-500"
            style={{ marginLeft: '-12px' }}
          />
        )}
      </Link>
    );
  };

  const Sidebar = () => (
    <div className="flex flex-col h-full w-[260px] bg-[#0B0E14] border-r border-white/5">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="text-sm font-bold text-white leading-tight">AI Shorts</div>
          <div className="text-[10px] text-blue-400 font-medium tracking-wider uppercase">Factory</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        <div className="space-y-1">
          <div className="px-3 mb-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Tổng Quan</div>
          {navItems.map(item => <NavLink key={item.path} item={item} />)}
        </div>
        <div className="space-y-1">
          <div className="px-3 mb-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Cấu Hình</div>
          {settingsItems.map(item => <NavLink key={item.path} item={item} />)}
        </div>
        <div className="space-y-1">
          <div className="px-3 mb-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Hệ Thống</div>
          {adminItems.map(item => <NavLink key={item.path} item={item} />)}
        </div>
      </div>

      <div className="p-3 border-t border-white/5">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
        >
          <LogOut className="w-[18px] h-[18px]" />
          <span>Đăng Xuất</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-[#0F1117] text-slate-200 overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:block shrink-0">
        <Sidebar />
      </div>

      {/* Mobile sidebar */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 bg-black/60 z-40 lg:hidden"
            />
            <motion.div
              initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed left-0 top-0 bottom-0 z-50 lg:hidden"
            >
              <Sidebar />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar */}
        <div className="lg:hidden flex items-center justify-between h-14 px-4 border-b border-white/5 bg-[#0B0E14]">
          <button onClick={() => setMobileOpen(true)} className="text-slate-400 hover:text-white">
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-400" />
            <span className="text-sm font-bold text-white">AI Shorts Factory</span>
          </div>
          <div className="w-6" />
        </div>

        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}