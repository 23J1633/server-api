const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const adminKey = process.env.A2S_ADMIN_KEY || ''
const instanceId = process.env.A2S_INSTANCE_ID || ''
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))

if (!adminKey) throw new Error('A2S_ADMIN_KEY is required')

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
      partition: `a2s-i18n-smoke-${process.pid}`,
    },
  })
  try {
    await window.loadURL(consoleUrl)
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)});
      ${instanceId ? `localStorage.setItem('dshInstance', ${JSON.stringify(instanceId)});` : ''}
      localStorage.setItem('dshConsoleSettings', JSON.stringify({ locale: 'en-US', theme: 'light' }));
    })()`)
    await window.loadURL(consoleUrl)
    await waitFor(window, () => document.documentElement.lang === 'en-US' && !!document.querySelector('.machineButton'))
    await window.webContents.executeJavaScript(`document.querySelector('.settingsTrigger')?.click()`)
    await waitFor(window, () => !!document.querySelector('.settingsPanel'))
    const result = await window.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('.settingsPanel');
      const sections = [];
      for (const button of panel.querySelectorAll('.navCell')) {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        const auditPanel = panel.cloneNode(true);
        auditPanel.querySelectorAll('pre').forEach((node) => node.remove());
        const text = auditPanel.innerText || '';
        sections.push({
          label: button.textContent.trim(),
          chinese: [...new Set(text.match(/[\\u3400-\\u9fff][^\\n]*/g) || [])],
        });
      }
      panel.querySelector('.navCell')?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const text = panel?.innerText || '';
      return {
        locale: document.documentElement.lang,
        title: document.title,
        panelText: text,
        sections,
        chinese: sections.flatMap((section) => section.chinese),
        languageControl: [...panel.querySelectorAll('.setRow')]
          .find((row) => row.textContent.includes('Language'))?.textContent || '',
      };
    })()`)
    const image = await window.capturePage()
    const output = join(outputDir, 'ui-en-settings.png')
    writeFileSync(output, image.toPNG())
    if (result.locale !== 'en-US' || !result.languageControl.includes('English') || result.chinese.length) {
      throw new Error(`English UI audit failed: ${JSON.stringify(result)}`)
    }
    console.log(JSON.stringify({ ok: true, ...result, panelText: undefined, output }))
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})

async function waitFor(window, predicate, timeoutMs = 15000) {
  const source = `(${predicate.toString()})()`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error('timed out waiting for console UI')
}
