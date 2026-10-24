import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Proxy /api -> backend: frontend va backend chung origin (localhost:5173),
// nen cookie dang nhap HttpOnly + SameSite=Lax hoat dong ma khong can CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3000',
        changeOrigin: false,
        // Gui IP that cua trinh duyet (X-Forwarded-For) cho gioi han dang nhap theo IP
        xfwd: true
      }
    }
  }
})
