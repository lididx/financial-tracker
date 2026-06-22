import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' makes asset paths relative — works from any subdirectory
// (e.g. /local/financial/ on Home Assistant, or root on Vercel/Netlify)
export default defineConfig({
  plugins: [react()],
  base: './',
})
