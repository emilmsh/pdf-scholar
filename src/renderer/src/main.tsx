import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/app.css'

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

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
