import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

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

export default function GoogleSignInButton({
  onSuccess,
  onError,
  text = "Tiếp tục với Google",
  disabled = false,
  className = "",
}) {
  const [loading, setLoading] = useState(false);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

  useEffect(() => {
    if (!clientId) return;

    // Load Google Identity Services script if not already loaded
    if (!window.google && !document.getElementById("google-gsi-client")) {
      const script = document.createElement("script");
      script.id = "google-gsi-client";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    }
  }, [clientId]);

  const handleGoogleClick = async () => {
    if (disabled || loading) return;
    setLoading(true);

    try {
      // 1. If Google Identity Services is available and client ID is set
      if (window.google?.accounts?.id && clientId) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            try {
              if (response?.credential && onSuccess) {
                await onSuccess(response.credential);
              }
            } catch (err) {
              if (onError) onError(err);
            } finally {
              setLoading(false);
            }
          },
        });
        window.google.accounts.id.prompt();
        return;
      }

      // 2. Dev / Local fallback: Prompt user for mock/simulated Google account
      const defaultEmail = "google.user@example.com";
      const emailInput = window.prompt(
        "Đăng nhập bằng tài khoản Google:\nNhập địa chỉ email Google để tiếp tục thử nghiệm:",
        defaultEmail
      );

      if (!emailInput || !emailInput.trim()) {
        setLoading(false);
        return;
      }

      const cleanEmail = emailInput.trim();
      // Generate standard mock Google credential JWT / payload
      const mockPayload = {
        iss: "https://accounts.google.com",
        sub: "google-uid-" + Math.random().toString(36).slice(2, 10),
        email: cleanEmail,
        email_verified: true,
        name: cleanEmail.split("@")[0],
        picture: "https://lh3.googleusercontent.com/a/default-user",
      };

      // Base64url encode simulated JWT payload for credential
      const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const payload = btoa(JSON.stringify(mockPayload));
      const simulatedCredential = `${header}.${payload}.simulated_signature`;

      if (onSuccess) {
        await onSuccess({
          credential: simulatedCredential,
          email: cleanEmail,
          name: mockPayload.name,
        });
      }
    } catch (err) {
      console.error("Google sign-in error:", err);
      if (onError) onError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleGoogleClick}
      disabled={disabled || loading}
      className={`w-full h-11 sm:h-12 border-border/80 bg-background/80 hover:bg-muted font-semibold text-xs sm:text-sm text-foreground flex items-center justify-center gap-2.5 rounded-xl shadow-xs transition-all cursor-pointer ${className}`}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
      ) : (
        <GoogleIcon className="w-4 h-4 shrink-0" />
      )}
      <span>{text}</span>
    </Button>
  );
}

GoogleSignInButton.propTypes = {
  onSuccess: PropTypes.func,
  onError: PropTypes.func,
  text: PropTypes.string,
  disabled: PropTypes.bool,
  className: PropTypes.string,
};
