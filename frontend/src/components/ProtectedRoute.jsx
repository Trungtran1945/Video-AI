import { Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

const DefaultFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

export default function ProtectedRoute({ fallback = <DefaultFallback />, unauthenticatedElement, requireRole }) {
  // AuthProvider owns initialization (silent cookie refresh on mount).
  // ProtectedRoute only consumes real state — no checkUserAuth indirection.
  const { isAuthenticated, isLoadingAuth, authChecked, authError, user } = useAuth();

  if (isLoadingAuth || !authChecked) {
    return fallback;
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    }
    return unauthenticatedElement;
  }

  if (!isAuthenticated) {
    return unauthenticatedElement;
  }

  // Role guard: 403 with explicit message (never silent empty).
  if (requireRole && user?.role !== requireRole) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <h3 className="text-sm sm:text-base font-semibold text-foreground">Thiếu quyền truy cập (403)</h3>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 max-w-md">
          Trang này yêu cầu vai trò {requireRole}. Tài khoản hiện tại là {user?.role || 'không rõ'}.
        </p>
      </div>
    );
  }

  return <Outlet />;
}
