import React, { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  LogIn,
  Mail,
  Lock,
  Loader2,
  Eye,
  EyeOff,
  KeyRound,
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  Send,
} from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import OtpInput from "@/components/auth/OtpInput";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, sendOtp, loginWithOtp } = useAuth();
  const { toast } = useToast();

  const from = location.state?.from?.pathname || "/dashboard";

  // Auth Mode: 'password' | 'otp'
  const [authMode, setAuthMode] = useState("password");

  // State cho Đăng nhập Mật khẩu
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // State cho Đăng nhập Email OTP
  const [otpStep, setOtpStep] = useState("request"); // 'request' | 'verify'
  const [otpEmail, setOtpEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpCooldownSec, setOtpCooldownSec] = useState(60);
  const [devOtp, setDevOtp] = useState(null);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [isResendingOtp, setIsResendingOtp] = useState(false);
  const [otpError, setOtpError] = useState("");
  const [otpSuccess, setOtpSuccess] = useState(false);

  // Xử lý chuyển tab
  const handleTabChange = (val) => {
    setAuthMode(val);
    setPasswordError("");
    setOtpError("");
    // Đồng bộ email nếu user đã gõ ở tab kia
    if (val === "otp" && email && !otpEmail) {
      setOtpEmail(email);
    } else if (val === "password" && otpEmail && !email) {
      setEmail(otpEmail);
    }
  };

  // 1. Submit Đăng nhập bằng Mật khẩu
  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordLoading(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setPasswordError(
        err?.response?.data?.message || err.message || "Email hoặc mật khẩu không chính xác"
      );
    } finally {
      setPasswordLoading(false);
    }
  };

  // Helper map lỗi OTP thân thiện
  const formatOtpError = (err) => {
    const data = err?.response?.data;
    if (data?.error === "OTP_INVALID" || data?.code === "OTP_INVALID") {
      if (data?.remainingAttempts !== undefined) {
        return `Mã OTP không đúng. Bạn còn ${data.remainingAttempts} lần thử.`;
      }
      return data?.message || "Mã OTP không chính xác. Vui lòng kiểm tra lại.";
    }
    if (data?.error === "OTP_EXPIRED" || data?.code === "OTP_EXPIRED") {
      return "Mã OTP đã hết hạn. Vui lòng nhấn 'Gửi lại mã' để nhận mã mới.";
    }
    if (data?.error === "OTP_MAX_ATTEMPTS" || data?.code === "OTP_MAX_ATTEMPTS") {
      return "Bạn đã nhập sai quá số lần quy định. Vui lòng yêu cầu mã OTP mới.";
    }
    if (err?.response?.status === 429) {
      const wait = data?.retryAfterSec ? ` sau ${data.retryAfterSec}s` : "";
      return `Bạn thao tác quá nhanh. Vui lòng thử lại${wait}.`;
    }
    return data?.message || err.message || "Thao tác không thành công. Vui lòng thử lại.";
  };

  // 2. Submit yêu cầu gửi mã OTP
  const handleSendOtp = async (e) => {
    if (e) e.preventDefault();
    const targetEmail = otpEmail.trim();
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      setOtpError("Vui lòng nhập địa chỉ email hợp lệ");
      return;
    }

    setOtpError("");
    setIsSendingOtp(true);
    try {
      const res = await sendOtp(targetEmail);
      if (res?.cooldownSec) {
        setOtpCooldownSec(res.cooldownSec);
      } else {
        setOtpCooldownSec(60);
      }
      if (res?.devOtp) {
        setDevOtp(res.devOtp);
      }
      setOtp("");
      setOtpStep("verify");
      toast({
        title: "Đã gửi mã xác thực",
        description: `Mã OTP gồm 6 số đã được gửi tới ${targetEmail}.`,
      });
    } catch (err) {
      setOtpError(formatOtpError(err));
    } finally {
      setIsSendingOtp(false);
    }
  };

  // 3. Gửi lại mã OTP
  const handleResendOtp = async () => {
    setIsResendingOtp(true);
    setOtpError("");
    try {
      const res = await sendOtp(otpEmail.trim());
      if (res?.cooldownSec) {
        setOtpCooldownSec(res.cooldownSec);
      } else {
        setOtpCooldownSec(60);
      }
      if (res?.devOtp) {
        setDevOtp(res.devOtp);
      }
      toast({
        title: "Đã gửi lại mã mới",
        description: "Vui lòng kiểm tra hộp thư đến hoặc hòm thư spam.",
      });
    } catch (err) {
      setOtpError(formatOtpError(err));
      throw err;
    } finally {
      setIsResendingOtp(false);
    }
  };

  // 4. Submit xác thực OTP & đăng nhập
  const handleVerifyOtp = async (e) => {
    if (e) e.preventDefault();
    if (otp.length !== 6) {
      setOtpError("Vui lòng nhập đủ 6 chữ số mã xác thực");
      return;
    }

    setOtpError("");
    setIsVerifyingOtp(true);
    try {
      await loginWithOtp(otpEmail.trim(), otp.trim());
      setOtpSuccess(true);
      toast({
        title: "Đăng nhập thành công",
        description: "Chào mừng bạn trở lại AI Shorts Factory!",
      });
      // Điều hướng tới trang đích
      setTimeout(() => {
        navigate(from, { replace: true });
      }, 500);
    } catch (err) {
      setOtpError(formatOtpError(err));
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  return (
    <AuthLayout
      icon={LogIn}
      title="Chào mừng trở lại"
      subtitle="Đăng nhập vào tài khoản AI Shorts Factory của bạn"
      shapeType="crystalTorus"
      footer={
        <>
          Chưa có tài khoản?{" "}
          <Link
            to="/register"
            className="text-primary font-bold hover:underline transition-colors"
          >
            Đăng ký ngay
          </Link>
        </>
      }
    >
      {/* Tabs chuyển đổi giữa Mật khẩu và Email OTP */}
      <Tabs value={authMode} onValueChange={handleTabChange} className="w-full">
        <TabsList className="grid w-full grid-cols-2 mb-5 h-11 bg-muted/60 p-1 rounded-xl">
          <TabsTrigger
            value="password"
            className="rounded-lg font-semibold text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all"
          >
            <Lock className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
            Mật khẩu
          </TabsTrigger>
          <TabsTrigger
            value="otp"
            className="rounded-lg font-semibold text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm transition-all"
          >
            <Mail className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
            Email OTP
          </TabsTrigger>
        </TabsList>

        {/* ================= TAB 1: ĐĂNG NHẬP MẬT KHẨU ================= */}
        <TabsContent value="password" className="mt-0 focus-visible:outline-none">
          {passwordError && (
            <div className="mb-4 p-3.5 rounded-xl bg-destructive/15 border border-destructive/30 text-destructive text-xs sm:text-sm font-medium">
              {passwordError}
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-foreground font-semibold text-xs sm:text-sm">
                Email
              </Label>
              <div className="relative">
                <Mail
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm"
                  required
                  disabled={passwordLoading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="password"
                  className="text-foreground font-semibold text-xs sm:text-sm"
                >
                  Mật khẩu
                </Label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-primary font-medium hover:underline"
                >
                  Quên mật khẩu?
                </Link>
              </div>
              <div className="relative">
                <Lock
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm"
                  required
                  disabled={passwordLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 transition-colors"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  disabled={passwordLoading}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-11 sm:h-12 font-bold text-sm sm:text-base rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all mt-2"
              disabled={passwordLoading}
            >
              {passwordLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Đang đăng nhập...
                </>
              ) : (
                "Đăng nhập"
              )}
            </Button>
          </form>
        </TabsContent>

        {/* ================= TAB 2: ĐĂNG NHẬP EMAIL OTP ================= */}
        <TabsContent value="otp" className="mt-0 focus-visible:outline-none">
          {otpError && (
            <div className="mb-4 p-3.5 rounded-xl bg-destructive/15 border border-destructive/30 text-destructive text-xs sm:text-sm font-medium animate-in fade-in-50">
              {otpError}
            </div>
          )}

          {otpSuccess && (
            <div className="mb-4 p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs sm:text-sm font-medium flex items-center gap-2 animate-in fade-in-50">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>Đăng nhập thành công! Đang chuyển hướng đến bảng điều khiển...</span>
            </div>
          )}

          {/* Bước 1: Yêu cầu gửi mã OTP */}
          {otpStep === "request" && (
            <form onSubmit={handleSendOtp} className="space-y-4">
              <div className="space-y-2">
                <Label
                  htmlFor="otp-email"
                  className="text-foreground font-semibold text-xs sm:text-sm"
                >
                  Email nhận mã OTP
                </Label>
                <div className="relative">
                  <Mail
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="otp-email"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    placeholder="you@example.com"
                    value={otpEmail}
                    onChange={(e) => setOtpEmail(e.target.value)}
                    className="pl-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm"
                    required
                    disabled={isSendingOtp}
                  />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed pt-1">
                  Mã xác thực gồm 6 số dùng một lần sẽ được gửi trực tiếp đến hộp thư của bạn.
                </p>
              </div>

              <Button
                type="submit"
                className="w-full h-11 sm:h-12 font-bold text-sm sm:text-base rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all mt-2"
                disabled={isSendingOtp || !otpEmail.trim()}
              >
                {isSendingOtp ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Đang gửi mã OTP...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Gửi mã xác thực OTP
                  </>
                )}
              </Button>
            </form>
          )}

          {/* Bước 2: Nhập mã OTP và Xác nhận */}
          {otpStep === "verify" && (
            <form onSubmit={handleVerifyOtp} className="space-y-4 animate-in fade-in-50">
              {/* Thẻ hiển thị email nhận mã kèm nút đổi email */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50 border border-border/60">
                <div className="flex items-center gap-2 overflow-hidden">
                  <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
                  <span className="text-xs sm:text-sm truncate text-muted-foreground">
                    Gửi tới: <strong className="text-foreground font-semibold">{otpEmail}</strong>
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOtpStep("request");
                    setOtp("");
                    setOtpError("");
                  }}
                  disabled={isVerifyingOtp}
                  className="h-7 px-2 text-xs text-primary hover:text-primary/90 hover:bg-primary/10 shrink-0"
                >
                  <ArrowLeft className="w-3 h-3 mr-1" />
                  Đổi email
                </Button>
              </div>

              {/* Dev mode OTP badge nếu backend trả về để test nhanh */}
              {devOtp && (
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-400 text-xs text-center font-mono font-medium">
                  Mã kiểm thử (Dev Mode): <strong>{devOtp}</strong>
                </div>
              )}

              {/* Component OtpInput 6 ô số rời nhau + Countdown Resend */}
              <div className="py-2">
                <OtpInput
                  value={otp}
                  onChange={setOtp}
                  onComplete={() => {
                    // Tự động kích hoạt khi nhập đủ 6 số nếu không đang loading
                    if (!isVerifyingOtp && !otpSuccess) {
                      handleVerifyOtp();
                    }
                  }}
                  disabled={isVerifyingOtp || otpSuccess}
                  hasError={Boolean(otpError)}
                  cooldownSec={otpCooldownSec}
                  onResend={handleResendOtp}
                  isResending={isResendingOtp}
                  autoFocus
                />
              </div>

              <Button
                type="submit"
                className="w-full h-11 sm:h-12 font-bold text-sm sm:text-base rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all mt-2"
                disabled={isVerifyingOtp || otp.length !== 6 || otpSuccess}
              >
                {isVerifyingOtp ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Đang xác thực mã...
                  </>
                ) : otpSuccess ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Đã xác thực thành công
                  </>
                ) : (
                  <>
                    <KeyRound className="w-4 h-4 mr-2" />
                    Xác nhận & Đăng nhập
                  </>
                )}
              </Button>
            </form>
          )}
        </TabsContent>
      </Tabs>
    </AuthLayout>
  );
}
