import React from "react";
import { Link } from "react-router-dom";
import { Film, ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function AuthLayout({
  icon: Icon,
  title,
  subtitle,
  footer,
  children,
}) {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4 py-12 select-none">
      {/* Top action bar */}
      <header className="absolute top-0 inset-x-0 z-30 flex items-center justify-between h-14 px-4 sm:px-8 max-w-7xl mx-auto border-b border-border/60">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-secondary border border-border/80 flex items-center justify-center text-primary">
              <Film className="w-3.5 h-3.5" />
            </div>
            <span className="font-medium text-xs sm:text-sm text-foreground tracking-tight hidden sm:inline">
              AI Shorts Factory
            </span>
          </Link>

          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-secondary border border-border transition-colors"
          >
            <ArrowLeft className="w-3 h-3 text-muted-foreground" />
            <span>Trang chủ</span>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle variant="quick" />
        </div>
      </header>

      {/* Auth Card Container */}
      <div className="w-full max-w-sm z-20 relative pt-10">
        {/* Header inside card */}
        <div className="text-center mb-5">
          {Icon && (
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-secondary text-primary border border-border mb-3">
              <Icon className="w-5 h-5" aria-hidden="true" />
            </div>
          )}
          <h1 className="text-xl sm:text-2xl font-medium tracking-tight text-foreground">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{subtitle}</p>
          )}
        </div>

        {/* Form Card */}
        <div className="bg-card rounded-xl border border-border p-6 shadow-xs transition-colors">
          {children}
        </div>

        {footer && (
          <p className="text-center text-xs text-muted-foreground mt-4 leading-relaxed">
            {footer}
          </p>
        )}
      </div>
    </div>
  );
}
