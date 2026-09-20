const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const apiBase = new URL('/a2s-api', consoleUrl).toString().replace(/\/$/, '')
const adminKey = process.env.A2S_ADMIN_KEY || ''
const instanceId = process.env.A2S_INSTANCE || ''
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))

if (!adminKey || !instanceId) throw new Error('A2S_ADMIN_KEY and A2S_INSTANCE are required')

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
      partition: `a2s-new-session-smoke-${process.pid}`,
    },
  })
  let createdSessionId = null
  try {
    await window.loadURL(consoleUrl)
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)});
      localStorage.setItem('dshInstance', ${JSON.stringify(instanceId)});
      localStorage.setItem('dshConsoleSettings', JSON.stringify({ locale: 'zh-CN', theme: 'light' }));
    })()`)
    await window.loadURL(consoleUrl)
    await waitFor(window, () => !!document.querySelector('.newSession:not(:disabled)'))
    const beforeDomIds = await window.webContents.executeJavaScript(`[
      ...document.querySelectorAll('.sessionRow')
    ].map((node) => node._session?.sessionId).filter(Boolean)`)
    const beforeRemoteIds = (await call('session.list', {}))?.items?.map((item) => item.sessionId) || []

    await window.webContents.executeJavaScript(`document.querySelector('.newSession')?.click()`)
    await waitFor(window, () => !!document.querySelector('.menuCard .menuItem'))
    const menuAudit = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.menuCard .menuItem')].map((node) => ({
      label: node.querySelector('.miLabel')?.textContent || '',
      meta: node.querySelector('.miMeta')?.textContent || '',
      selected: node.classList.contains('selected'),
      disabled: node.disabled,
    }))`)
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const item = document.querySelector('.menuCard .menuItem.selected')
        || document.querySelector('.menuCard .menuItem');
      if (!item) return false;
      item.click();
      return true;
    })()`)
    if (!clicked) throw new Error(`new-session menu had no clickable item: ${JSON.stringify(menuAudit)}`)

    const createDeadline = Date.now() + 60000
    while (Date.now() < createDeadline && !createdSessionId) {
      const sessions = await call('session.list', {})
      createdSessionId = sessions?.items?.find((item) => !beforeRemoteIds.includes(item.sessionId))?.sessionId ?? null
      if (!createdSessionId) await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    }
    if (!createdSessionId) {
      const toasts = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.toast')].map((node) => node.textContent.trim())`)
      throw new Error(`new-session click created no session; menu=${JSON.stringify(menuAudit)}; toasts=${JSON.stringify(toasts)}; domSessions=${beforeDomIds.length}; remoteSessions=${beforeRemoteIds.length}`)
    }
    await waitFor(window, (sessionId) => (
      document.querySelector('.sessionRow.selected')?._session?.sessionId === sessionId
      && !!document.querySelector('.composerCard')
    ), createdSessionId, 60000)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700))

    const audit = await window.webContents.executeJavaScript(`(() => ({
      sessionId: document.querySelector('.sessionRow.selected')?._session?.sessionId || null,
      errorToasts: [...document.querySelectorAll('.toast.error')].map((node) => node.textContent.trim()),
      composers: document.querySelectorAll('.composerCard').length,
      title: document.querySelector('.conversationHeader')?.textContent?.trim() || '',
    }))()`)
    if (audit.sessionId !== createdSessionId) throw new Error('UI did not select the newly-created session')
    if (audit.errorToasts.length) throw new Error(`new-session UI showed an error: ${audit.errorToasts.join(' | ')}`)
    if (audit.composers !== 1) throw new Error(`new-session UI expected one composer, got ${audit.composers}`)

    const output = join(outputDir, 'ui-codex-new-session.png')
    const image = await window.webContents.capturePage()
    writeFileSync(output, image.toPNG())
    console.log(JSON.stringify({ ok: true, sessionId: createdSessionId, menuAudit, ...audit, output }))
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  } finally {
    if (createdSessionId) await call('session.archive', { sessionId: createdSessionId }).catch(() => null)
    window.destroy()
    app.quit()
  }
})

async function call(method, params) {
  const response = await fetch(`${apiBase}/instances/${encodeURIComponent(instanceId)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ method, params }),
  })
  const body = await response.json()
  if (!response.ok || body?.ok === false) throw new Error(body?.error?.message || `HTTP ${response.status}`)
  return body.result
}

async function waitFor(window, predicate, argument, timeoutMs = 30000) {
  const source = `(${predicate.toString()})(${JSON.stringify(argument)})`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source).catch(() => false)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`UI condition timed out after ${timeoutMs}ms`)
}
