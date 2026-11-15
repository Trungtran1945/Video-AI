import React, { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Loader2, AlertCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const SCRIPT_ID = "google-gsi-client";
const SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const LOAD_TIMEOUT_MS = 10000;

export function GoogleIcon({ className = "w-4 h-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
        fill="#EA4335"
      />
    </svg>
  );
}

GoogleIcon.propTypes = {
  className: PropTypes.string,
};

/**
 * Maps custom button text to Google Identity Services standard enum values:
 * 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
 */
function resolveGsiText(text) {
  if (!text || typeof text !== "string") return "signin_with";
  const lower = text.toLowerCase();
  if (lower.includes("ký") || lower.includes("sign up") || lower.includes("signup") || lower.includes("register")) {
    return "signup_with";
  }
  if (lower.includes("tiếp tục") || lower.includes("continue")) {
    return "continue_with";
  }
  return "signin_with";
}

export default function GoogleSignInButton({
  onSuccess,
  onError,
  text = "Đăng nhập với Google",
  disabled = false,
  className = "",
  theme = "outline",
  size = "large",
  shape = "rectangular",
  logoAlignment = "left",
  width,
}) {
  const containerRef = useRef(null);
  const isSubmittingRef = useRef(false);

  // SDK status: 'idle' | 'loading' | 'ready' | 'error'
  const [sdkStatus, setSdkStatus] = useState("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

  // Helper to load or verify Google Identity Services script
  const loadGsiScript = useCallback(() => {
    if (!clientId) {
      setSdkStatus("error");
      setErrorMessage("Chưa cấu hình Google Client ID (VITE_GOOGLE_CLIENT_ID).");
      return;
    }

    if (window.google?.accounts?.id) {
      setSdkStatus("ready");
      setErrorMessage("");
      return;
    }

    setSdkStatus("loading");
    setErrorMessage("");

    let existingScript = document.getElementById(SCRIPT_ID);
    let timer = null;

    const handleSuccess = () => {
      if (timer) clearTimeout(timer);
      if (window.google?.accounts?.id) {
        setSdkStatus("ready");
      } else {
        setSdkStatus("error");
        setErrorMessage("Dịch vụ Google Identity không khởi tạo được.");
      }
    };

    const handleError = () => {
      if (timer) clearTimeout(timer);
      setSdkStatus("error");
      setErrorMessage("Không thể tải dịch vụ Google. Vui lòng kiểm tra kết nối mạng hoặc tiện ích chặn quảng cáo.");
    };

    timer = setTimeout(() => {
      if (!window.google?.accounts?.id) {
        setSdkStatus("error");
        setErrorMessage("Hết thời gian kết nối tới Google Identity Services.");
      }
    }, LOAD_TIMEOUT_MS);

    if (existingScript) {
      if (existingScript.getAttribute("data-loaded") === "true") {
        handleSuccess();
      } else {
        existingScript.addEventListener("load", handleSuccess, { once: true });
        existingScript.addEventListener("error", handleError, { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      script.setAttribute("data-loaded", "true");
      handleSuccess();
    }, { once: true });
    script.addEventListener("error", handleError, { once: true });

    document.head.appendChild(script);
  }, [clientId]);

  useEffect(() => {
    loadGsiScript();
  }, [loadGsiScript]);

  // Handle Google Credential Response
  const handleCredentialResponse = useCallback(
    async (response) => {
      if (isSubmittingRef.current) return;

      if (!response?.credential) {
        const errorObj = new Error("Không nhận được chứng thực hợp lệ từ Google.");
        if (onError) onError(errorObj);
        return;
      }

      isSubmittingRef.current = true;
      setIsAuthenticating(true);

      try {
        if (onSuccess) {
          // Pass the genuine Google ID Token string to consumer
          await onSuccess(response.credential);
        }
      } catch (err) {
        console.error("Google authentication error:", err);
        if (onError) onError(err);
      } finally {
        isSubmittingRef.current = false;
        setIsAuthenticating(false);
      }
    },
    [onSuccess, onError]
  );

  // Render official Google button when SDK is ready and DOM ref is attached
  useEffect(() => {
    if (sdkStatus !== "ready" || !containerRef.current || !window.google?.accounts?.id || !clientId) {
      return;
    }

    try {
      // 1. Initialize Google Identity Services
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      // 2. Clear container to prevent duplicate iframes
      containerRef.current.innerHTML = "";

      // 3. Calculate button width clamped to Google's constraints [200, 400]
      let resolvedWidth;
      if (typeof width === "number") {
        resolvedWidth = Math.min(400, Math.max(200, width));
      } else if (typeof width === "string" && !isNaN(parseInt(width, 10))) {
        resolvedWidth = Math.min(400, Math.max(200, parseInt(width, 10)));
      } else {
        const containerWidth = containerRef.current.offsetWidth || 380;
        resolvedWidth = Math.min(400, Math.max(200, containerWidth));
      }

      const buttonConfig = {
        type: "standard",
        theme: theme || "outline",
        size: size || "large",
        text: resolveGsiText(text),
        shape: shape || "rectangular",
        logo_alignment: logoAlignment || "left",
        width: resolvedWidth,
        locale: "vi",
      };

      // 4. Render official Google button
      window.google.accounts.id.renderButton(containerRef.current, buttonConfig);
    } catch (err) {
      console.error("Error rendering Google Identity button:", err);
      setSdkStatus("error");
      setErrorMessage("Không thể kết xuất nút Google Identity.");
    }
  }, [sdkStatus, clientId, text, theme, size, shape, logoAlignment, width, handleCredentialResponse]);

  // Loading state placeholder with matching height to prevent layout shift
  if (sdkStatus === "loading") {
    return (
      <div
        className={`w-full min-h-[44px] sm:min-h-[48px] rounded-xl border border-border/80 bg-background/50 flex items-center justify-center gap-2.5 text-xs sm:text-sm text-muted-foreground font-medium transition-all ${className}`}
        aria-busy="true"
        aria-label="Đang kết nối dịch vụ Google"
      >
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span>Đang kết nối Google...</span>
      </div>
    );
  }

  // Error state with retry action
  if (sdkStatus === "error") {
    return (
      <div className={`w-full space-y-2 ${className}`}>
        <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/25 text-destructive text-xs sm:text-sm font-medium flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1 leading-snug">{errorMessage || "Không thể kết nối dịch vụ Google."}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={loadGsiScript}
          className="w-full h-9 rounded-lg text-xs font-semibold border-border/80 hover:bg-muted cursor-pointer flex items-center justify-center gap-1.5"
        >
          <RotateCw className="w-3.5 h-3.5" />
          <span>Thử lại kết nối Google</span>
        </Button>
      </div>
    );
  }

  // Ready state: container for Google's official rendered button
  const isDisabled = disabled || isAuthenticating;

  return (
    <div
      className={`relative w-full flex justify-center items-center min-h-[44px] sm:min-h-[48px] transition-opacity ${
        isDisabled ? "pointer-events-none opacity-60" : ""
      } ${className}`}
    >
      {/* Official Google rendered iframe will mount inside this container */}
      <div ref={containerRef} className="w-full flex justify-center items-center" />

      {/* Authenticating overlay for double-click protection */}
      {isAuthenticating && (
        <div className="absolute inset-0 bg-background/70 backdrop-blur-[1px] flex items-center justify-center rounded-xl z-10 gap-2 text-xs sm:text-sm font-semibold text-foreground animate-in fade-in-50">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span>Đang xác thực Google...</span>
        </div>
      )}
    </div>
  );
}

GoogleSignInButton.propTypes = {
  onSuccess: PropTypes.func,
  onError: PropTypes.func,
  text: PropTypes.string,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  theme: PropTypes.oneOf(["outline", "filled_blue", "filled_black"]),
  size: PropTypes.oneOf(["large", "medium", "small"]),
  shape: PropTypes.oneOf(["rectangular", "pill", "circle", "square"]),
  logoAlignment: PropTypes.oneOf(["left", "center"]),
  width: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
};
