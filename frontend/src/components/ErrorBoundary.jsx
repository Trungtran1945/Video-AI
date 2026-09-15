import { Component } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Lỗi giao diện:', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl bg-card border border-border p-8 text-center shadow-lg">
          <div className="w-14 h-14 rounded-2xl bg-destructive/15 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-7 h-7 text-destructive" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">Đã xảy ra lỗi</h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            Trang gặp sự cố khi hiển thị. Vui lòng thử tải lại; nếu vẫn lỗi, hãy quay lại sau.
          </p>
          {this.state.error?.message && (
            <pre className="mt-4 text-left text-xs text-muted-foreground bg-muted/60 border border-border rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-words font-mono">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition shadow-md shadow-primary/25"
          >
            <RotateCcw className="w-4 h-4" /> Tải lại trang
          </button>
        </div>
      </div>
    );
  }
}
