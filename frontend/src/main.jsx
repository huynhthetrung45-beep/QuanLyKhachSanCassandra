import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import './App.css'
import './extensions/extensions.css'
import './extensions/theme.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary message="ChatOTT gặp lỗi khi hiển thị. Phiên đăng nhập của bạn vẫn được giữ.">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
