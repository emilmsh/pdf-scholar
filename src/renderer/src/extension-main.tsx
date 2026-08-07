import ReactDOM from 'react-dom/client'
import ExtensionApp from './ExtensionApp'
import { initTouchUi } from './touch-ui'
import './styles/app.css'

// Finger-sized targets follow the input in use (html.touch-ui) — see touch-ui.ts
initTouchUi()

// Entry point for the browser-extension viewer page. The renderer's platform
// bridge (bridge.ts) detects the WebExtension context and routes window.api
// calls through extension-api.ts. Each viewer page hosts exactly one PDF (one
// browser tab), so we mount the single-document shell rather than App.tsx.

ReactDOM.createRoot(document.getElementById('root')!).render(<ExtensionApp />)
