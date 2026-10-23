import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { datasets } from './vite-datasets'

// `npm run build:single` bundles everything into one HTML file (handy for sharing a preview).
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    datasets(process.env.DATASETS_DIR ?? 'src/datasets'), // LeRobot datasets -> /__datasets
    datasets(process.env.EVALS_DIR ?? 'src/evals', '/__evals'), // evaluation runs (eval.json + videos) -> /__evals
    ...(mode === 'single' ? [viteSingleFile()] : []),
  ],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist' },
  server: {
    // Don't watch gigabytes of robot data for code changes.
    watch: { ignored: ['**/src/datasets/**', '**/src/evals/**', '**/src/data/**/*.mp4', '**/src/data/**/*.parquet'] },
    proxy: {
      // Point /api at your team's backend (FastAPI etc.) while developing.
      '/api': { target: process.env.API_TARGET ?? 'http://localhost:8000', changeOrigin: true },
      // VLM review (Select): any OpenAI-compatible server, e.g. vLLM on the GPU machine.
      '/vlm': { target: process.env.VLM_TARGET ?? 'http://localhost:8001', changeOrigin: true, rewrite: (p) => p.replace(/^\/vlm/, '') },
    },
  },
}))
