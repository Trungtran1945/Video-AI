import React from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import { Film, ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * AuthLayout:
 * Standard no-scroll viewport layout for authentication pages.
 * Stays cleanly within 100dvh across desktop/laptop resolutions (>=700px)
 * with graceful scrolling fallback on ultra-small mobile screens (<550px).
 */
export default function AuthLayout({
  icon: Icon,
  title,
  subtitle,
  footer,
  children,
}) {
  return (
    <div className="h-[100dvh] max-h-[100dvh] w-full flex flex-col bg-background text-foreground select-none overflow-hidden">
      {/* Top action bar */}
      <header className="shrink-0 flex items-center justify-between h-11 sm:h-12 px-4 sm:px-6 w-full border-b border-border/50 bg-background/80 backdrop-blur-sm z-30">
        <div className="flex items-center gap-2.5 sm:gap-3">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="w-6.5 h-6.5 rounded-md bg-secondary border border-border/80 flex items-center justify-center text-primary group-hover:border-primary/50 transition-colors">
              <Film className="w-3.5 h-3.5" />
            </div>
            <span className="font-semibold text-xs sm:text-sm text-foreground tracking-tight hidden sm:inline">
              AI Shorts Factory
            </span>
          </Link>

          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-normal text-muted-foreground hover:text-foreground hover:bg-secondary border border-border/70 transition-colors"
          >
            <ArrowLeft className="w-3 h-3 text-muted-foreground" />
            <span>Trang chủ</span>
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle variant="quick" />
        </div>
      </header>

      {/* Main Centered Content */}
      <main className="flex-1 flex items-center justify-center px-3 sm:px-4 py-2 sm:py-3 min-h-0 overflow-y-auto sm:overflow-y-visible">
        <div className="w-full max-w-[420px] sm:max-w-[440px] z-20 relative my-auto">
          {/* Header inside card */}
          <div className="text-center mb-3 sm:mb-3.5">
            {Icon && (
              <div className="inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-secondary text-primary border border-border/80 mb-2 shadow-xs">
                <Icon className="w-4 h-4 sm:w-4.5 sm:h-4.5" aria-hidden="true" />
              </div>
            )}
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">{title}</h1>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5 leading-normal">{subtitle}</p>
            )}
          </div>

          {/* Form Card */}
          <div className="bg-card rounded-2xl border border-border/80 p-4 sm:p-5 shadow-xs transition-colors">
            {children}
          </div>

          {footer && (
            <div className="text-center text-xs text-muted-foreground mt-2.5 sm:mt-3 leading-relaxed">
              {footer}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

AuthLayout.propTypes = {
  icon: PropTypes.elementType,
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  footer: PropTypes.node,
  children: PropTypes.node.isRequired,
};
