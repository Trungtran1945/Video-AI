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
      <div className="min-h-screen bg-[#0F1117] text-slate-200 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl bg-[#161922] border border-white/5 p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-red-500/15 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-7 h-7 text-red-400" />
          </div>
          <h1 className="text-lg font-semibold text-white">Đã xảy ra lỗi</h1>
          <p className="text-sm text-slate-400 mt-2 leading-relaxed">
            Trang gặp sự cố khi hiển thị. Vui lòng thử tải lại; nếu vẫn lỗi, hãy quay lại sau.
          </p>
          {this.state.error?.message && (
            <pre className="mt-4 text-left text-xs text-slate-500 bg-[#0F1117] border border-white/5 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition shadow-lg shadow-blue-600/30"
          >
            <RotateCcw className="w-4 h-4" /> Tải lại trang
          </button>
        </div>
      </div>
    );
  }
}
