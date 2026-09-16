import React from "react";
import { Link } from "react-router-dom";
import { Sparkles, ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import Auth3DBackground from "@/components/Auth3DBackground";

export default function AuthLayout({
  icon: Icon,
  title,
  subtitle,
  footer,
  shapeType = "crystalTorus",
  children,
}) {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4 py-16 overflow-hidden select-none">
      
      {/* 3D Animated Background Shape */}
      <Auth3DBackground shapeType={shapeType} />

      {/* Top action bar */}
      <header className="absolute top-0 inset-x-0 z-30 flex items-center justify-between h-16 px-4 sm:px-8 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/25 group-hover:scale-105 transition-transform">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm sm:text-base text-foreground tracking-tight hidden sm:inline">
              AI Shorts Factory
            </span>
          </Link>

          {/* Nút quay lại trang chủ trên thanh điều hướng */}
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold text-foreground bg-card/70 hover:bg-card border border-border/80 hover:border-primary/40 shadow-xs backdrop-blur-md transition-all group"
          >
            <ArrowLeft className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-1 text-primary" />
            <span>Trang chủ</span>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle variant="quick" />
        </div>
      </header>

      {/* Auth Card Container */}
      <div className="w-full max-w-md z-20 relative">
        {/* Subtle Back link inside card area for mobile clarity */}
        <div className="mb-3">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-primary transition-colors group"
          >
            <ArrowLeft className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-1 text-primary" />
            <span>Quay lại trang chủ</span>
          </Link>
        </div>

        {/* Header inside card */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 text-primary border border-primary/25 mb-3 shadow-md shadow-primary/10 backdrop-blur-md">
            <Icon className="w-7 h-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">{title}</h1>
          {subtitle && (
            <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 leading-relaxed">{subtitle}</p>
          )}
        </div>

        {/* Glassmorphic Form Card */}
        <div className="bg-card/90 dark:bg-card/85 rounded-3xl shadow-2xl border border-border/90 dark:border-white/10 p-6 sm:p-8 backdrop-blur-2xl transition-colors">
          {children}
        </div>

        {footer && (
          <p className="text-center text-xs sm:text-sm text-muted-foreground mt-6 leading-relaxed">
            {footer}
          </p>
        )}
      </div>
    </div>
  );
}
