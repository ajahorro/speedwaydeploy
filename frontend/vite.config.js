import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-icons': ['lucide-react'],
          // Receipt OCR is imported lazily in utils/receiptOcr.js so it is only
          // fetched when a customer actually uploads a receipt. Without an entry
          // here it was folded into the main `index` chunk, which DEFEATED the
          // lazy import: every visitor downloaded the OCR engine on first paint
          // and the main bundle grew by ~250 kB. Naming it as its own chunk is
          // what makes the deferral real.
          'vendor-ocr': ['tesseract.js'],
        },
      },
    },
  },
})
