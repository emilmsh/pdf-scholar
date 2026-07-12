// Capture README screenshots by driving the renderer in an offscreen
// Electron window against the dev-web server. Run with the dev server up:
//   npm run dev:web   (separate terminal)   then   npx electron scripts/capture-screenshots.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const URL = 'http://localhost:5199'
const OUT = path.join(__dirname, '..', 'docs', 'screenshots')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

async function capture(win, name) {
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, name), image.toPNG())
  console.log('wrote', name)
}

function run(win, script) {
  return win.webContents.executeJavaScript(`(async () => { ${script} })()`, true)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { offscreen: true }
  })
  win.webContents.setFrameRate(10)
  await win.loadURL(URL)
  await wait(1500)

  // Open the sample document and let it render
  await run(
    win,
    `const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
     for(let i=0;i<40&&!document.querySelector('.welcome');i++)await wait(200);
     document.querySelector('.btn-secondary')?.click();
     for(let i=0;i<80&&!document.querySelector('.pdf-page canvas');i++)await wait(250);
     await wait(1200);`
  )
  await capture(win, 'reading.png')

  // Sidebar (contents) + a selection menu would need interaction; show the
  // AI assistant with the mock conversation instead
  await run(
    win,
    `const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
     document.querySelector('button[title^="Assistent"]')?.click();
     await wait(400);
     document.querySelector('.ai-suggestions button')?.click();
     for(let i=0;i<60;i++){await wait(250);if(document.querySelector('.ai-chip'))break;}
     await wait(400);`
  )
  await capture(win, 'assistant.png')

  // Parchment theme
  await run(
    win,
    `const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
     document.querySelector('.ai-header button[title*="Lukk"], .ai-header button:last-child')?.click();
     await wait(200);
     document.documentElement.dataset.theme='sepia';
     document.querySelector('button[title*="Sidepanel"]')?.click();
     await wait(1200);`
  )
  await capture(win, 'parchment.png')

  app.quit()
})
