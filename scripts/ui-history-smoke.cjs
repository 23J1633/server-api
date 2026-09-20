const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const adminKey = process.env.A2S_ADMIN_KEY || ''
const instanceId = process.env.A2S_INSTANCE || ''
const sessionId = process.env.A2S_SESSION || ''
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))

if (!adminKey || !instanceId || !sessionId) {
  throw new Error('A2S_ADMIN_KEY, A2S_INSTANCE and A2S_SESSION are required')
}

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
      partition: `a2s-history-smoke-${process.pid}`,
    },
  })

  try {
    await window.loadURL(consoleUrl)
    await window.webContents.executeJavaScript(`(() => {
      localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)});
      localStorage.setItem('dshInstance', ${JSON.stringify(instanceId)});
      localStorage.setItem('dshConsoleSettings', JSON.stringify({ locale: 'zh-CN', theme: 'light' }));
    })()`)
    await window.loadURL(consoleUrl)
    await waitFor(window, (wanted) => [...document.querySelectorAll('.sessionRow')]
      .some((node) => node._session?.sessionId === wanted), sessionId, 30000)

    await window.webContents.executeJavaScript(`(() => {
      window.__a2sOlderCalls = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        try {
          const body = JSON.parse(args[1]?.body || '{}');
          if (body.method === 'session.events' && Number.isFinite(body.params?.beforeSeq)) {
            window.__a2sOlderCalls += 1;
          }
        } catch {}
        return originalFetch(...args);
      };
      const row = [...document.querySelectorAll('.sessionRow')]
        .find((node) => node._session?.sessionId === ${JSON.stringify(sessionId)});
      row?.click();
    })()`)

    await waitFor(window, () => document.querySelectorAll('.flowItem').length > 0
      && !!document.querySelector('.olderRow:not(.hidden) .olderStatus'), null, 30000)
    const initial = await metrics(window)
    if (!initial.hasOlder) throw new Error(`fixture has no older history: ${JSON.stringify(initial)}`)

    // Simulate one uninterrupted upward gesture. The test never writes a larger
    // scrollTop; any positive jump comes only from the application's anchor
    // preservation after a page is prepended.
    await window.webContents.executeJavaScript(`(() => {
      const scroll = document.querySelector('.convScroll');
      window.__a2sScrollWrites = [];
      window.__a2sHistoryTimer = setInterval(() => {
        if (!scroll?.isConnected) return;
        const next = Math.max(0, scroll.scrollTop - 180);
        window.__a2sScrollWrites.push({ from: scroll.scrollTop, to: next });
        scroll.scrollTop = next;
      }, 20);
    })()`)

    await waitFor(window, () => window.__a2sOlderCalls >= 2, null, 45000)
    await window.webContents.executeJavaScript(`clearInterval(window.__a2sHistoryTimer)`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    const final = await metrics(window)
    const writes = await window.webContents.executeJavaScript(`window.__a2sScrollWrites || []`)
    if (writes.some((entry) => entry.to > entry.from)) throw new Error('test gesture unexpectedly scrolled downward')
    if (final.olderCalls < 2 || final.flowItems <= initial.flowItems) {
      throw new Error(`history did not auto-load continuously: ${JSON.stringify({ initial, final })}`)
    }

    const output = join(outputDir, 'ui-history-auto-load.png')
    const image = await window.capturePage()
    writeFileSync(output, image.toPNG())
    console.log(JSON.stringify({ ok: true, initial, final, upwardWrites: writes.length, output }))
  } finally {
    await window.webContents.executeJavaScript(`clearInterval(window.__a2sHistoryTimer)`).catch(() => undefined)
    window.destroy()
    app.quit()
  }
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})

async function metrics(window) {
  return await window.webContents.executeJavaScript(`(() => {
    const scroll = document.querySelector('.convScroll');
    return {
      olderCalls: window.__a2sOlderCalls || 0,
      flowItems: document.querySelectorAll('.flowItem').length,
      hasOlder: !!document.querySelector('.olderRow:not(.hidden)'),
      scrollTop: scroll?.scrollTop ?? null,
      scrollHeight: scroll?.scrollHeight ?? null,
      clientHeight: scroll?.clientHeight ?? null,
    };
  })()`)
}

async function waitFor(window, predicate, argument, timeoutMs) {
  const source = `(${predicate.toString()})(${JSON.stringify(argument)})`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`timed out waiting for ${argument || 'history condition'}`)
}
