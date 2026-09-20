const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const apiBase = new URL('/a2s-api', consoleUrl).toString().replace(/\/$/, '')
const adminKey = process.env.A2S_ADMIN_KEY || ''
const instanceId = process.env.A2S_INSTANCE || process.env.A2S_CODEX_INSTANCE || ''
const agentType = process.env.A2S_AGENT_TYPE || instanceId.split(':').at(-1) || 'agent'
const uiLocale = process.env.A2S_UI_LOCALE || 'en-US'
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))

if (!adminKey || !instanceId) throw new Error('A2S_ADMIN_KEY and A2S_INSTANCE are required')

app.whenReady().then(async () => {
  mkdirSync(outputDir, { recursive: true })
  const token = `A2S_UI_${agentType.toUpperCase()}_${Date.now()}`
  const title = `A2S ${agentType} UI 验收 ${Date.now()}`
  const created = await call('session.create', { cwd: 'D:\\Project\\A2S', title })
  const catalog = await call('session.modelCatalog', {}).catch(() => null)
  const selectedModel = catalog?.default || null
  if (selectedModel?.model) {
    await call('session.selectModel', { sessionId: created.sessionId, ...selectedModel })
  }

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
      partition: `a2s-live-smoke-${process.pid}`,
    },
  })
  try {
    await window.loadURL(consoleUrl)
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)});
      localStorage.setItem('dshInstance', ${JSON.stringify(instanceId)});
      localStorage.setItem('dshConsoleSettings', JSON.stringify({ locale: ${JSON.stringify(uiLocale)}, theme: 'light' }));
    })()`)
    await window.loadURL(consoleUrl)
    await waitFor(window, (sessionId) => [...document.querySelectorAll('.sessionRow')]
      .some((node) => node._session?.sessionId === sessionId), created.sessionId)
    await waitFor(window, () => !!document.querySelector('.heroComposer .composerInput'))
    const heroLayout = await inspectComposerLayout(window, '.heroComposer')
    if (!heroLayout.sameRow) throw new Error(`hero composer controls wrapped: ${JSON.stringify(heroLayout)}`)
    await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.sessionRow')]
        .find((node) => node._session?.sessionId === ${JSON.stringify(created.sessionId)});
      row?.click();
    })()`)
    await waitFor(window, () => !!document.querySelector('.composerInput'))
    const sessionLayout = await inspectComposerLayout(window, '.composerWrap:not(.heroComposer)')
    if (!sessionLayout.sameRow) throw new Error(`session composer controls wrapped: ${JSON.stringify(sessionLayout)}`)

    const sentAt = Date.now()
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.composerInput');
      input.value = ${JSON.stringify(`请只回复 ${token}，不要添加其他内容。`)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    })()`)

    let userEchoAt = null
    let liveAt = null
    let finalAt = null
    let idleAt = null
    const deadline = Date.now() + 180000
    while (Date.now() < deadline && !idleAt) {
      const observed = await window.webContents.executeJavaScript(`(() => ({
        user: [...document.querySelectorAll('.flowItem[data-kind="user"]')].some((node) => node.textContent.includes(${JSON.stringify(token)})),
        live: !![...document.querySelectorAll('.flowItem[data-key="live"]')].find((node) => node.textContent.trim().length > 0),
        final: [...document.querySelectorAll('.flowItem[data-kind="assistant-step"]:not([data-key="live"])')]
          .some((node) => node.textContent.includes(${JSON.stringify(token)})),
        running: document.querySelector('.sendButton')?.classList.contains('stop') || false,
      }))()`)
      const now = Date.now()
      if (observed.user && !userEchoAt) userEchoAt = now
      if (observed.live && !liveAt) liveAt = now
      if (observed.final) finalAt = now
      if (observed.final && !observed.running) idleAt = now
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    if (!userEchoAt || !liveAt || !finalAt || !idleAt) {
      throw new Error(`live UI verification failed: ${JSON.stringify({ userEchoAt, liveAt, finalAt, idleAt })}`)
    }
    const matchingUserMessages = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('.flowItem[data-kind="user"]')]
        .filter((node) => node.textContent.includes(${JSON.stringify(token)})).length`)
    if (matchingUserMessages !== 1) throw new Error(`expected one user message, got ${matchingUserMessages}`)
    const chatChrome = await window.webContents.executeJavaScript(`({
      composers: document.querySelectorAll('.composerCard').length,
      submissionEchoes: document.querySelectorAll('[data-submission-echo]').length,
      userMessages: document.querySelectorAll('.flowItem[data-kind="user"]').length,
    })`)
    if (chatChrome.composers !== 1 || chatChrome.submissionEchoes !== 0 || chatChrome.userMessages !== 1) {
      throw new Error(`chat chrome did not settle: ${JSON.stringify(chatChrome)}`)
    }

    await window.webContents.executeJavaScript(`document.querySelector('.convTab:not(.active)')?.click()`)
    await waitFor(window, () => !!document.querySelector('.tjRoot'))
    const trajectoryChrome = await window.webContents.executeJavaScript(`({
      composers: document.querySelectorAll('.composerCard').length,
      tooltipOwners: document.querySelectorAll('.span[data-timeline-span]').length,
    })`)
    if (trajectoryChrome.composers !== 0) throw new Error(`trajectory unexpectedly contains composer: ${JSON.stringify(trajectoryChrome)}`)
    const trajectoryOutput = join(outputDir, `ui-${agentType}-trajectory.png`)
    await capture(window, trajectoryOutput)
    if (trajectoryChrome.tooltipOwners > 0 && agentType === 'codex') {
      const tooltipPoint = await window.webContents.executeJavaScript(`(() => {
        const owner = [...document.querySelectorAll('.span[data-timeline-span]')]
          .find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        if (!owner) return null;
        const rect = owner.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`)
      if (!tooltipPoint) throw new Error('trajectory tooltip fixture has no visible owner')
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(tooltipPoint.x),
        y: Math.round(tooltipPoint.y),
      })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 900))
      const tooltipVisible = await window.webContents.executeJavaScript(`!!document.querySelector('.tjTooltip')`)
      if (!tooltipVisible) throw new Error('trajectory tooltip fixture did not open')
      await window.webContents.executeJavaScript(`document.querySelector('.convTab:not(.active)')?.click()`)
      await waitFor(window, () => !!document.querySelector('.composerCard'))
      const leakedTooltip = await window.webContents.executeJavaScript(`!!document.querySelector('.tjTooltip')`)
      if (leakedTooltip) throw new Error('trajectory tooltip leaked after leaving the view')
    } else {
      await window.webContents.executeJavaScript(`document.querySelector('.convTab:not(.active)')?.click()`)
      await waitFor(window, () => !!document.querySelector('.composerCard'))
    }
    const uiAudit = await window.webContents.executeJavaScript(`(() => {
      const values = [
        document.querySelector('.olderStatus')?.textContent || '',
        document.querySelector('.composerInput')?.placeholder || '',
        document.querySelector('.composerCard')?.textContent || '',
        document.querySelector('.composerStats')?.textContent || '',
        ...[...document.querySelectorAll('.maCost')].map((node) => node.textContent || ''),
      ];
      return values.filter((value) => /[\u3400-\u9fff]/.test(value));
    })()`)
    if (uiAudit.length) throw new Error(`English UI still contains untranslated chrome: ${JSON.stringify(uiAudit)}`)
    const output = join(outputDir, `ui-${agentType}-live-complete.png`)
    await capture(window, output)
    console.log(JSON.stringify({
      ok: true,
      agentType,
      sessionId: created.sessionId,
      userEchoMs: userEchoAt - sentAt,
      firstVisibleStreamMs: liveAt - sentAt,
      finalMs: finalAt - sentAt,
      idleMs: idleAt - sentAt,
      matchingUserMessages,
      heroLayout,
      sessionLayout,
      chatChrome,
      trajectoryChrome,
      trajectoryOutput,
      untranslatedChrome: uiAudit,
      optimisticEcho: userEchoAt - sentAt < 200,
      output,
    }))
  } finally {
    await call('session.archive', { sessionId: created.sessionId }).catch(() => undefined)
    window.destroy()
    app.quit()
  }
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})

async function call(method, params) {
  const response = await fetch(`${apiBase}/instances/${encodeURIComponent(instanceId)}/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ method, params }),
  })
  const body = await response.json()
  if (!response.ok || body?.ok === false) throw new Error(body?.error?.message || `${method}: HTTP ${response.status}`)
  return body.result
}

async function waitFor(window, predicate, argument, timeoutMs = 15000) {
  const source = `(${predicate.toString()})(${JSON.stringify(argument)})`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`timed out waiting for ${argument || 'console UI'}`)
}

async function capture(window, path) {
  await window.webContents.executeJavaScript(`new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))`)
  const image = await window.capturePage()
  writeFileSync(path, image.toPNG())
}

async function inspectComposerLayout(window, selector) {
  return await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const command = root?.querySelector('.composerTools .pillButton');
    const model = root?.querySelector('.modelTrigger');
    const row = root?.querySelector('.composerRow');
    if (!root || !command || !model || !row) return { found: false, sameRow: false };
    const commandBox = command.getBoundingClientRect();
    const modelBox = model.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return {
      found: true,
      sameRow: Math.abs(commandBox.top - modelBox.top) < 3 && rowBox.height < 44,
      commandTop: commandBox.top,
      modelTop: modelBox.top,
      rowHeight: rowBox.height,
    };
  })()`)
}
