import ReactDOM from 'react-dom/client'
import ExtensionApp from './ExtensionApp'
import './styles/app.css'

// Entry point for the browser-extension viewer page. The renderer's platform
// bridge (bridge.ts) detects the WebExtension context and routes window.api
// calls through extension-api.ts. Each viewer page hosts exactly one PDF (one
// browser tab), so we mount the single-document shell rather than App.tsx.

ReactDOM.createRoot(document.getElementById('root')!).render(<ExtensionApp />)
