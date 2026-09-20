const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const adminKey = process.env.A2S_ADMIN_KEY || ''
const instanceId = process.env.A2S_CODEX_INSTANCE || ''
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))

if (!adminKey || !instanceId) throw new Error('A2S_ADMIN_KEY and A2S_CODEX_INSTANCE are required')

app.whenReady().then(async () => {
  mkdirSync(outputDir, { recursive: true })
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition: `a2s-content-smoke-${process.pid}`,
    },
  })
  try {
    await window.loadURL(consoleUrl)
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)});
      localStorage.setItem('dshInstance', ${JSON.stringify(instanceId)});
    })()`)
    await window.loadURL(consoleUrl)
    await waitFor(window, () => [...document.querySelectorAll('.sessionRow .title')]
      .some((node) => node.textContent.includes('完善多 Agent 服务器生态')))

    await window.webContents.executeJavaScript(`(() => {
      const title = [...document.querySelectorAll('.sessionRow .title')]
        .find((node) => node.textContent.includes('完善多 Agent 服务器生态'));
      title?.closest('.sessionRow')?.click();
    })()`)
    await waitFor(window, () => document.querySelectorAll('.messageImage').length >= 3, null, 30000)
    await window.webContents.executeJavaScript(`document.querySelector('.messageImage')?.scrollIntoView({ block: 'center' })`)
    await waitFor(window, () => document.querySelector('.messageImage')?.naturalWidth > 0, null, 15000)
    const imageStates = await window.webContents.executeJavaScript(`(() => ({
      images: [...document.querySelectorAll('.messageImage')].map((image) => ({
        dataUrl: image.src.startsWith('data:image/'), srcLength: image.src.length, complete: image.complete,
        width: image.naturalWidth, height: image.naturalHeight,
        classes: image.className, alt: image.alt,
      })),
      fallbacks: [...document.querySelectorAll('.remoteFileFallback')].map((node) => node.textContent),
    }))()`)
    if (imageStates.images.length < 3 || !imageStates.images[0].dataUrl || imageStates.images[0].width <= 0) {
      throw new Error(`remote images failed to load: ${JSON.stringify(imageStates)}`)
    }

    const imageResult = await window.webContents.executeJavaScript(`(() => {
      const images = [...document.querySelectorAll('.messageImage')];
      images[0].click();
      return { count: images.length, loaded: images.every((image) => image.naturalWidth > 0) };
    })()`)
    await waitFor(window, () => document.querySelector('.remoteImagePreview')?.naturalWidth > 0)
    const imagePreview = await window.webContents.executeJavaScript(`(() => {
      const image = document.querySelector('.remoteImagePreview');
      return { loaded: image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight };
    })()`)
    await capture(window, join(outputDir, 'ui-codex-image-preview.png'))
    await window.webContents.executeJavaScript(`document.querySelector('.overlay .settingsClose')?.click()`)

    await window.webContents.executeJavaScript(`import('/js/file-preview.js').then((module) => module.openRemoteFile('C:\\\\Users\\\\29715\\\\.ssh\\\\config', 'SSH config'))`)
    await waitFor(window, () => document.querySelector('.remoteTextPreview')?.textContent?.length > 0)
    const filePreview = await window.webContents.executeJavaScript(`(() => ({
      visible: !!document.querySelector('.remoteTextPreview'),
      characters: document.querySelector('.remoteTextPreview')?.textContent?.length || 0,
    }))()`)
    await capture(window, join(outputDir, 'ui-host-file-preview.png'))

    console.log(JSON.stringify({ ok: true, imageStates, imageResult, imagePreview, filePreview, outputDir }))
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})

async function waitFor(window, predicate, argument, timeoutMs = 15000) {
  const source = `(${predicate.toString()})(${JSON.stringify(argument)})`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error(`timed out waiting for ${argument || 'console UI'}`)
}

async function capture(window, path) {
  await window.webContents.executeJavaScript(`new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))`)
  const image = await window.capturePage()
  writeFileSync(path, image.toPNG())
}
