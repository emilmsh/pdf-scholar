import ReactDOM from 'react-dom/client'
import ExtensionApp from './ExtensionApp'
import AssistantApp from './AssistantApp'
import { parseAssistantTarget } from '../../shared/viewer-url'
import { initTouchUi } from './touch-ui'
import { installOcr } from './ocr'
import './styles/app.css'

// Finger-sized targets follow the input in use (html.touch-ui) — see touch-ui.ts
initTouchUi()

// Scanned pages get their text from OCR, on this machine (ocr.ts) — without
// this the text layer still shows OCR words, but search and the assistant
// see the scan as empty
installOcr()

// Entry point for the browser-extension viewer page. The renderer's platform
// bridge (bridge.ts) detects the WebExtension context and routes window.api
// calls through extension-api.ts. Each viewer page hosts exactly one PDF (one
// browser tab), so we mount the single-document shell rather than App.tsx —
// unless the URL says ?view=assistant, which makes this tab the detached
// assistant for the document instead (opened by bridge.openAssistant).

const assistantFor = parseAssistantTarget(location.href)

ReactDOM.createRoot(document.getElementById('root')!).render(
  assistantFor ? <AssistantApp docPath={assistantFor} /> : <ExtensionApp />
)
