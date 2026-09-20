const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const apiBase = new URL('/a2s-api', consoleUrl).toString().replace(/\/$/, '')
const adminKey = process.env.A2S_ADMIN_KEY || ''
const instanceId = process.env.A2S_INSTANCE || ''
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))
const workspacePath = resolve(__dirname, '..', '..', 'cc2server')
const workspaceTitle = `CC UI smoke ${process.pid}`

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
      partition: `a2s-claude-history-workspace-smoke-${process.pid}`,
    },
  })
  let workspaceCreated = false
  try {
    // Start with the test folder hidden so the browser must exercise the real
    // create-workspace path instead of reusing a visible registration.
    await call('workspace.remove', { path: workspacePath }).catch(() => null)

    const sessions = (await call('session.list', { limit: 100 }))?.items || []
    const candidates = []
    for (const session of sessions.slice(0, 30)) {
      const page = await call('session.events', { sessionId: session.sessionId, limit: 200 }).catch(() => null)
      const events = Array.isArray(page?.events) ? page.events : []
      const user = events.filter((event) => event.type === 'user/message').length
      const assistant = events.filter((event) => event.type === 'assistant/message').length
      const answers = events.filter((event) => event.type === 'assistant/message'
        && (Array.isArray(event.data?.message?.content)
          ? event.data.message.content.some((block) => (!block?.type || block.type === 'text') && String(block?.text ?? block).trim())
          : String(event.data?.message?.content ?? '').trim())).length
      if (user && answers) candidates.push({
        sessionId: session.sessionId,
        events: events.length,
        user,
        assistant,
        answers,
        hasMore: page?.hasMore === true,
      })
    }
    // Prefer a complete, reasonably-sized persisted transcript. A huge page is
    // covered by the dedicated history-pagination smoke test and would make
    // this workspace/history check depend on unrelated auto-loading work.
    candidates.sort((a, b) => Number(a.hasMore) - Number(b.hasMore) || b.events - a.events)
    const target = candidates[0]
    if (!target) throw new Error('Claude bridge exposed no persisted conversation with user and assistant messages')

    await window.loadURL(consoleUrl)
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)});
      localStorage.setItem('dshInstance', ${JSON.stringify(instanceId)});
      localStorage.setItem('dshConsoleSettings', JSON.stringify({ locale: 'zh-CN', theme: 'light' }));
    })()`)
    await window.loadURL(consoleUrl)
    await waitFor(window, (sessionId) => [...document.querySelectorAll('.sessionRow')]
      .some((node) => node._session?.sessionId === sessionId), target.sessionId, 60000)

    // Create a workspace through the visible directory picker.
    await clickGroupAction(window, resolve(__dirname, '..', '..'))
    await clickMenuItem(window, '新建工作区')
    await waitFor(window, () => !!document.querySelector('.modalCard .directoryPicker'))
    const entered = await window.webContents.executeJavaScript(`(() => {
      const wanted = ${JSON.stringify(workspacePath.toLowerCase())};
      const entry = [...document.querySelectorAll('.directoryEntry')]
        .find((node) => String(node.title || '').toLowerCase() === wanted);
      if (!entry) return false;
      entry.click();
      return true;
    })()`)
    if (!entered) throw new Error(`directory picker did not expose ${workspacePath}`)
    await waitFor(window, (path) => document.querySelector('.directoryPath')?.textContent?.toLowerCase() === path.toLowerCase(), workspacePath)
    await window.webContents.executeJavaScript(`document.querySelector('.modalCard footer .btn.primary:not(:disabled)')?.click()`)
    await waitFor(window, (path) => [...document.querySelectorAll('.groupRow')]
      .some((node) => node._group?.cwd?.toLowerCase() === path.toLowerCase()), workspacePath)
    workspaceCreated = true

    // Rename the inferred/registered group through its actual context menu.
    await clickGroupAction(window, workspacePath)
    await clickMenuItem(window, '重命名')
    await waitFor(window, () => !!document.querySelector('.modalCard input.input'))
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.modalCard input.input');
      input.value = ${JSON.stringify(workspaceTitle)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.modalCard footer .btn.primary')?.click();
    })()`)
    await waitFor(window, (expected) => [...document.querySelectorAll('.groupRow .gLabel')]
      .some((node) => node.textContent.trim() === expected), workspaceTitle)

    // Load an older native Claude JSONL conversation in a fresh renderer.
    await waitFor(window, (sessionId) => [...document.querySelectorAll('.sessionRow')]
      .some((node) => node._session?.sessionId === sessionId), target.sessionId)
    const opened = await window.webContents.executeJavaScript(`(() => {
      const sessionId = ${JSON.stringify(target.sessionId)};
      const row = [...document.querySelectorAll('.sessionRow')]
        .find((node) => node._session?.sessionId === sessionId);
      if (!row) return false;
      row.click();
      return true;
    })()`)
    if (!opened) throw new Error(`persisted Claude session row disappeared: ${target.sessionId}`)
    await waitFor(window, (expected) => (
      document.querySelector('.sessionRow.selected')?._session?.sessionId === expected.sessionId
      && document.querySelectorAll('.flowItem[data-kind="user"]').length === expected.user
      && document.querySelectorAll('.flowItem[data-kind="assistant-step"]').length === expected.answers
    ), { sessionId: target.sessionId, user: target.user, answers: target.answers }, 60000)

    const audit = await window.webContents.executeJavaScript(`(() => ({
      selectedSessionId: document.querySelector('.sessionRow.selected')?._session?.sessionId || null,
      userMessages: document.querySelectorAll('.flowItem[data-kind="user"]').length,
      assistantMessages: document.querySelectorAll('.flowItem[data-kind="assistant-step"]').length,
      errorToasts: [...document.querySelectorAll('.toast.error')].map((node) => node.textContent.trim()),
      workspaceTitleVisible: [...document.querySelectorAll('.groupRow .gLabel')]
        .some((node) => node.textContent.trim() === ${JSON.stringify(workspaceTitle)}),
    }))()`)
    if (audit.selectedSessionId !== target.sessionId) throw new Error('UI did not select the persisted Claude session')
    if (!audit.userMessages || !audit.assistantMessages) throw new Error('persisted Claude transcript did not render')
    if (audit.assistantMessages !== target.answers) {
      throw new Error(`persisted Claude transcript rendered ${audit.assistantMessages} answers; expected ${target.answers}`)
    }
    if (!audit.workspaceTitleVisible) throw new Error('workspace rename was not reflected in the UI')
    if (audit.errorToasts.length) throw new Error(`Claude UI showed an error: ${audit.errorToasts.join(' | ')}`)

    const output = join(outputDir, 'ui-claude-history-restored.png')
    const image = await window.webContents.capturePage()
    writeFileSync(output, image.toPNG())

    // Remove from the visible list through the UI; this only changes bridge
    // registration metadata and never touches the local directory.
    await clickGroupAction(window, workspacePath)
    await clickMenuItem(window, '从列表移除')
    await waitFor(window, () => !!document.querySelector('.modalCard footer .btn.danger'))
    await window.webContents.executeJavaScript(`document.querySelector('.modalCard footer .btn.danger')?.click()`)
    await waitFor(window, (path) => ![...document.querySelectorAll('.groupRow')]
      .some((node) => node._group?.cwd?.toLowerCase() === path.toLowerCase()), workspacePath)
    workspaceCreated = false

    console.log(JSON.stringify({
      ok: true,
      restored: target,
      workspace: { created: true, renamed: true, removed: true, path: workspacePath },
      ...audit,
      output,
    }))
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  } finally {
    if (workspaceCreated) await call('workspace.remove', { path: workspacePath }).catch(() => null)
    window.destroy()
    app.quit()
  }
})

async function clickGroupAction(window, path) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(path.toLowerCase())};
    const row = [...document.querySelectorAll('.groupRow')]
      .find((node) => node._group?.cwd?.toLowerCase() === wanted);
    const button = row?.querySelector('.rowActions button');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`workspace row action was unavailable for ${path}`)
  await waitFor(window, () => !!document.querySelector('.menuCard .menuItem'))
}

async function clickMenuItem(window, label) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const label = ${JSON.stringify(label)};
    const item = [...document.querySelectorAll('.menuCard .menuItem')]
      .find((node) => node.querySelector('.miLabel')?.textContent?.includes(label));
    if (!item || item.disabled) return false;
    item.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`menu item was unavailable: ${label}`)
}

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
