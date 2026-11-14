import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  UserPlus,
  Mail,
  Lock,
  Loader2,
  Eye,
  EyeOff,
  User,
  ArrowLeft,
  ShieldCheck,
  CheckCircle2,
} from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import OtpInput from "@/components/auth/OtpInput";
import GoogleSignInButton from "@/components/auth/GoogleSignInButton";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";

export default function Register() {
  const navigate = useNavigate();
  const { registerSendOtp, registerVerifyOtp, googleLogin } = useAuth();
  const { toast } = useToast();

  // Registration step: 'form' | 'otp'
  const [step, setStep] = useState("form");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // OTP State
  const [otp, setOtp] = useState("");
  const [cooldownSec, setCooldownSec] = useState(60);
  const [devOtp, setDevOtp] = useState(null);
  const [isResending, setIsResending] = useState(false);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const formatAuthError = (err) => {
    if (err?.response?.status === 429) {
      const wait = err.response.data?.retryAfterSec
        ? ` sau ${err.response.data.retryAfterSec} giây`
        : " sau ít phút";
      return (
        err.response.data?.message ||
        `Bạn đã thao tác quá nhiều lần liên tiếp (Rate limit). Vui lòng thử lại${wait}.`
      );
    }
    const data = err?.response?.data;
    if (data?.error === "EMAIL_EXISTS" || data?.code === "EMAIL_EXISTS") {
      return "Địa chỉ email này đã được đăng ký. Vui lòng đăng nhập hoặc dùng email khác.";
    }
    if (data?.error === "INVALID_OTP" || data?.code === "INVALID_OTP") {
      if (data?.remainingAttempts !== undefined) {
        return `Mã OTP không chính xác. Bạn còn ${data.remainingAttempts} lần thử.`;
      }
      return data?.message || "Mã OTP không chính xác. Vui lòng kiểm tra lại.";
    }
    if (data?.error === "OTP_EXPIRED" || data?.code === "OTP_EXPIRED") {
      return "Mã OTP đã hết hạn. Vui lòng bấm 'Gửi lại mã' để nhận mã mới.";
    }
    return (
      data?.message ||
      data?.error?.message ||
      err.message ||
      "Đăng ký không thành công. Vui lòng thử lại."
    );
  };

  // Step 1: Send registration OTP
  const handleFormSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Vui lòng nhập địa chỉ email hợp lệ");
      return;
    }
    if (password.length < 6) {
      setError("Mật khẩu phải có ít nhất 6 ký tự");
      return;
    }
    if (password !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp");
      return;
    }

    setLoading(true);
    try {
      const res = await registerSendOtp(email.trim(), password, name.trim() || undefined);
      if (res?.cooldownSec) {
        setCooldownSec(res.cooldownSec);
      } else {
        setCooldownSec(60);
      }
      if (res?.devOtp) {
        setDevOtp(res.devOtp);
      }
      setOtp("");
      setStep("otp");
      toast({
        title: "Đã gửi mã xác thực",
        description: `Mã OTP gồm 6 chữ số đã được gửi tới ${email.trim()}.`,
      });
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify registration OTP & complete signup
  const handleVerifyOtp = async (codeToVerify) => {
    const finalOtp = codeToVerify || otp;
    if (!finalOtp || finalOtp.length !== 6) {
      setError("Vui lòng nhập đủ 6 chữ số của mã OTP");
      return;
    }

    setError("");
    setLoading(true);
    try {
      await registerVerifyOtp(
        email.trim(),
        finalOtp,
        password,
        name.trim() || undefined
      );
      toast({
        title: "Đăng ký thành công!",
        description: "Chào mừng bạn đến với AI Media Composer & Video AI Studio.",
      });
      navigate("/dashboard");
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  // Resend OTP in Step 2
  const handleResendOtp = async () => {
    setIsResending(true);
    setError("");
    try {
      const res = await registerSendOtp(email.trim(), password, name.trim() || undefined);
      if (res?.cooldownSec) {
        setCooldownSec(res.cooldownSec);
      } else {
        setCooldownSec(60);
      }
      if (res?.devOtp) {
        setDevOtp(res.devOtp);
      }
      toast({
        title: "Đã gửi lại mã OTP",
        description: "Vui lòng kiểm tra hộp thư đến hoặc thư mục rác (Spam).",
      });
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setIsResending(false);
    }
  };

  // Google Sign-In Success Handler
  const handleGoogleSuccess = async (credentialData) => {
    setError("");
    setLoading(true);
    try {
      await googleLogin(credentialData);
      toast({
        title: "Đăng nhập Google thành công!",
        description: "Chào mừng bạn đến với Video AI Studio.",
      });
      navigate("/dashboard");
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleError = (err) => {
    setError(formatAuthError(err));
  };

  return (
    <AuthLayout
      icon={step === "otp" ? ShieldCheck : UserPlus}
      title={step === "otp" ? "Xác thực tài khoản" : "Tạo tài khoản mới"}
      subtitle={
        step === "otp"
          ? `Nhập mã xác thực 6 số đã được gửi tới ${email}`
          : "Bắt đầu sản xuất video Shorts tự động ngay hôm nay"
      }
      shapeType="orbitalGyro"
      footer={
        <>
          Đã có tài khoản?{" "}
          <Link to="/login" className="text-primary font-bold hover:underline transition-colors">
            Đăng nhập
          </Link>
        </>
      }
    >
      {error && (
        <div className="mb-4 p-3.5 rounded-xl bg-destructive/15 border border-destructive/30 text-destructive text-xs sm:text-sm font-medium leading-relaxed">
          {error}
        </div>
      )}

      {/* DEV OTP Helper */}
      {devOtp && (
        <div className="mb-4 p-3 rounded-xl bg-primary/10 border border-primary/20 text-xs text-foreground flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
            <span>Mã OTP thử nghiệm (Dev mode): <strong className="font-mono text-primary text-sm">{devOtp}</strong></span>
          </div>
          <button
            type="button"
            onClick={() => {
              setOtp(devOtp);
              handleVerifyOtp(devOtp);
            }}
            className="text-[11px] underline text-primary font-semibold hover:opacity-80 cursor-pointer"
          >
            Điền nhanh
          </button>
        </div>
      )}

      {step === "form" ? (
        <div className="space-y-4">
          {/* Google Sign-In Option */}
          <GoogleSignInButton
            onSuccess={handleGoogleSuccess}
            onError={handleGoogleError}
            text="Đăng ký nhanh với Google"
            disabled={loading}
          />

          <div className="relative flex items-center justify-center my-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border/80" />
            </div>
            <div className="relative px-3 bg-card text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Hoặc với email
            </div>
          </div>

          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-foreground font-semibold text-xs sm:text-sm">
                Tên hiển thị <span className="font-normal text-muted-foreground">(tùy chọn)</span>
              </Label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Tên của bạn"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="pl-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-foreground font-semibold text-xs sm:text-sm">
                Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm rounded-xl"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-foreground font-semibold text-xs sm:text-sm">
                Mật khẩu
              </Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 pr-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm rounded-xl"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 transition-colors cursor-pointer"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm" className="text-foreground font-semibold text-xs sm:text-sm">
                Xác nhận mật khẩu
              </Label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="confirm"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pl-10 pr-10 h-11 sm:h-12 bg-background/70 border-border/80 text-foreground placeholder:text-muted-foreground/70 focus:border-primary text-sm rounded-xl"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 transition-colors cursor-pointer"
                  aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-11 sm:h-12 font-bold text-sm sm:text-base rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all mt-2 cursor-pointer"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Đang gửi mã xác thực...
                </>
              ) : (
                "Nhận mã OTP để đăng ký"
              )}
            </Button>
          </form>
        </div>
      ) : (
        /* Step 2: OTP Verification */
        <div className="space-y-6">
          <div className="p-3.5 rounded-xl bg-muted/40 border border-border flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 truncate">
              <Mail className="w-4 h-4 text-primary shrink-0" />
              <span className="font-semibold text-foreground truncate">{email}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setStep("form");
                setError("");
              }}
              className="inline-flex items-center gap-1 text-primary hover:underline font-semibold shrink-0 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Đổi</span>
            </button>
          </div>

          <div className="flex flex-col items-center">
            <OtpInput
              value={otp}
              onChange={setOtp}
              onComplete={handleVerifyOtp}
              disabled={loading}
              hasError={Boolean(error)}
              cooldownSec={cooldownSec}
              onResend={handleResendOtp}
              isResending={isResending}
              autoFocus
            />
          </div>

          <Button
            type="button"
            onClick={() => handleVerifyOtp()}
            className="w-full h-11 sm:h-12 font-bold text-sm sm:text-base rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25 transition-all cursor-pointer"
            disabled={loading || otp.length !== 6}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Đang hoàn tất đăng ký...
              </>
            ) : (
              "Xác nhận & Hoàn tất đăng ký"
            )}
          </Button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setStep("form");
                setError("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Quay lại chỉnh sửa thông tin</span>
            </button>
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
