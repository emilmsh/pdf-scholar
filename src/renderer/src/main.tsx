import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles/app.css'

// The renderer fires and forgets a lot of async work (saves, engine writes, AI
// calls). Each site that can meaningfully recover handles its own failure, but
// anything that slips through used to vanish without trace — there was no
// handler of any kind. This does not try to recover; it makes the failure
// findable, which is the difference between a bug report and a shrug.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[pdfx] unhandled rejection:', e.reason)
})

// Dev-only (browser preview): pdf.js drives rendering with requestAnimationFrame,
// which never fires in a hidden tab — fall back to setTimeout so automated
// preview/testing works. Never active in the Electron app.
if (import.meta.env.DEV && !window.api) {
  const nativeRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    if (document.hidden) {
      return window.setTimeout(() => cb(performance.now()), 16)
    }
    return nativeRaf(cb)
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
