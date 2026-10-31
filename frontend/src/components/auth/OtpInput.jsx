import React, { useEffect, useState, useRef } from "react";
import PropTypes from "prop-types";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Button } from "@/components/ui/button";
import { RotateCw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * OtpInput component
 * - 6 ô số rời nhau với input-otp
 * - Hỗ trợ auto-focus, paste chuỗi 6 số, backspace lùi ô
 * - Đồng hồ đếm ngược cho nút "Gửi lại mã OTP"
 */
export default function OtpInput({
  value = "",
  onChange,
  onComplete,
  disabled = false,
  hasError = false,
  cooldownSec = 60,
  onResend,
  isResending = false,
  autoFocus = true,
  className,
}) {
  const [timeLeft, setTimeLeft] = useState(cooldownSec);
  const timerRef = useRef(null);

  // Cập nhật khi cooldownSec từ cha thay đổi (ví dụ API trả về retryAfterSec mới)
  useEffect(() => {
    setTimeLeft(cooldownSec);
  }, [cooldownSec]);

  // Bộ đếm ngược 1s
  useEffect(() => {
    if (timeLeft <= 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timeLeft]);

  const handleResendClick = async () => {
    if (timeLeft > 0 || disabled || isResending) return;
    if (onResend) {
      try {
        await onResend();
        // Reset timer nếu resend thành công
        setTimeLeft(cooldownSec || 60);
      } catch {
        // lỗi xử lý ở parent
      }
    }
  };

  const handleChange = (val) => {
    if (onChange) onChange(val);
    if (val.length === 6 && onComplete) {
      onComplete(val);
    }
  };

  return (
    <div className={cn("flex flex-col items-center space-y-4 w-full", className)}>
      {/* 6 ô nhập mã OTP */}
      <div className="flex justify-center w-full">
        <InputOTP
          maxLength={6}
          value={value}
          onChange={handleChange}
          pattern={REGEXP_ONLY_DIGITS}
          disabled={disabled}
          autoFocus={autoFocus}
          containerClassName="justify-center"
        >
          <InputOTPGroup className="gap-2 sm:gap-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <InputOTPSlot
                key={index}
                index={index}
                className={cn(
                  "w-10 h-12 sm:w-12 sm:h-14 text-base sm:text-xl font-bold rounded-xl border border-border/80 bg-background/80 shadow-sm transition-all text-center",
                  "focus:border-primary focus:ring-2 focus:ring-primary/25",
                  hasError && "border-destructive/80 text-destructive focus:ring-destructive/20",
                  disabled && "opacity-50 cursor-not-allowed"
                )}
              />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>

      {/* Bộ đếm ngược & Nút gửi lại mã */}
      <div className="flex items-center justify-between w-full text-xs sm:text-sm px-1">
        <div className="text-muted-foreground flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" aria-hidden="true" />
          {timeLeft > 0 ? (
            <span>
              Gửi lại sau <strong className="text-foreground font-semibold">{timeLeft}s</strong>
            </span>
          ) : (
            <span className="text-muted-foreground">Chưa nhận được mã?</span>
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleResendClick}
          disabled={timeLeft > 0 || disabled || isResending}
          className={cn(
            "h-8 px-2.5 text-xs sm:text-sm font-semibold transition-colors",
            timeLeft === 0 && !disabled && !isResending
              ? "text-primary hover:text-primary/90 hover:bg-primary/10 cursor-pointer"
              : "text-muted-foreground/60 cursor-not-allowed"
          )}
        >
          <RotateCw
            className={cn("w-3.5 h-3.5 mr-1.5", isResending && "animate-spin")}
            aria-hidden="true"
          />
          {isResending ? "Đang gửi..." : "Gửi lại mã"}
        </Button>
      </div>
    </div>
  );
}

OtpInput.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  onComplete: PropTypes.func,
  disabled: PropTypes.bool,
  hasError: PropTypes.bool,
  cooldownSec: PropTypes.number,
  onResend: PropTypes.func,
  isResending: PropTypes.bool,
  autoFocus: PropTypes.bool,
  className: PropTypes.string,
};
