import React from 'react';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

const UserNotRegisteredError = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background p-6">
      <div className="max-w-md w-full p-8 bg-card rounded-2xl shadow-xl border border-border">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 mb-6 rounded-2xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-3">Truy Cập Bị Giới Hạn</h1>
          <p className="text-muted-foreground text-sm mb-6 leading-relaxed">
            Tài khoản của bạn chưa được cấp quyền truy cập ứng dụng. Vui lòng liên hệ quản trị viên hệ thống để yêu cầu quyền sử dụng.
          </p>
          <div className="p-4 bg-muted/60 rounded-xl text-left text-xs text-muted-foreground border border-border/80 space-y-2">
            <p className="font-semibold text-foreground">Bạn có thể thử:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Kiểm tra email đăng nhập đã chính xác chưa</li>
              <li>Liên hệ quản trị viên cấp quyền tài khoản</li>
              <li>Thử đăng xuất và đăng nhập lại</li>
            </ul>
          </div>
          <div className="mt-6 flex justify-center">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-primary hover:underline"
            >
              <ArrowLeft className="w-4 h-4" /> Quay lại đăng nhập
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserNotRegisteredError;
