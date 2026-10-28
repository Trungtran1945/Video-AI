import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import ErrorBoundary from '@/components/ErrorBoundary.jsx'
import '@/index.css'

// ErrorBoundary ngoài cùng: bắt lỗi init ở AuthProvider / QueryClient /
// Router / ThemeProvider (boundary trong App.jsx chỉ bao routes).
ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
