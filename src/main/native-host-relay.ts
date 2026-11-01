// The process the browser starts for the extension's ChatGPT plan: the app's
// executable in Node mode, run by the launcher script the native-messaging
// manifest names (shared/native-host.ts says why there are two steps).
// Bundled alone by scripts/build-native-host.mjs into
// out/native-host/pdf-scholar-host.cjs — Node built-ins only.
//
// It owns the browser's pipes and nothing else: it starts the app again in
// Electron mode as the host (native-host.ts), feeds it the browser's stdin
// untouched, and passes its stdout on from the HOST_READY marker — dropping
// the line break Electron writes before any code runs. When the browser
// closes the port the child's stdin ends and the child leaves on its own,
// after any renewal in hand has been stored; when the child goes, so does
// this.
import { spawn } from 'node:child_process'
import { NATIVE_HOST_SWITCH, ReadyStripper } from '../shared/native-host'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// An unpackaged run (a test against `npm run build`) is node_modules' electron,
// which needs the app's folder as its first argument; the packaged app does not
const appDir = process.env.PDFX_NATIVE_HOST_APP
const child = spawn(process.execPath, [...(appDir ? [appDir] : []), NATIVE_HOST_SWITCH], {
  env,
  stdio: ['pipe', 'pipe', 'ignore'],
  windowsHide: true
})

const stripper = new ReadyStripper()
child.stdout.on('data', (chunk: Buffer) => {
  let out: Uint8Array
  try {
    out = stripper.push(chunk)
  } catch {
    child.kill()
    return
  }
  if (out.length) process.stdout.write(out)
})
// The child gone first (it ended, or stdin closing ended it): close our end
// so the event loop drains what is still on its way out and stops
const leave = (code: number): void => {
  process.exitCode = code
  process.stdin.destroy()
}
child.on('close', (code) => leave(code ?? 1))
child.on('error', () => leave(1))
child.stdin.on('error', () => {
  /* the child is gone; 'close' handles it */
})
process.stdin.pipe(child.stdin)
