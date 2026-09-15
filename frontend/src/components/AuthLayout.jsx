import React from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function AuthLayout({ icon: Icon, title, subtitle, footer, children }) {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-background px-4 py-12">
      {/* Top action bar */}
      <header className="absolute top-0 inset-x-0 flex items-center justify-between h-16 px-6 max-w-7xl mx-auto">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-sm shadow-blue-500/20 group-hover:scale-105 transition-transform">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-sm text-foreground">AI Shorts Factory</span>
        </Link>
        <ThemeToggle variant="quick" />
      </header>

      {/* Auth Card */}
      <div className="w-full max-w-md z-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 text-primary border border-primary/20 mb-4 shadow-sm">
            <Icon className="w-7 h-7" aria-hidden="true" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-2">{subtitle}</p>}
        </div>

        <div className="bg-card rounded-2xl shadow-xl border border-border p-6 sm:p-8 backdrop-blur-sm">
          {children}
        </div>

        {footer && (
          <p className="text-center text-sm text-muted-foreground mt-6">{footer}</p>
        )}
      </div>
    </div>
  );
}
