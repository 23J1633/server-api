const { app, BrowserWindow } = require('electron')
const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const consoleUrl = process.env.A2S_CONSOLE_URL || 'http://127.0.0.1:50443/'
const adminKey = process.env.A2S_ADMIN_KEY || ''
const targets = JSON.parse(process.env.A2S_SMOKE_AGENTS || '[]')
const outputDir = resolve(process.env.A2S_SMOKE_OUTPUT_DIR || join(__dirname, '..', 'artifacts'))
const firstMachineToken = machineToken(targets[0])
const expectedMachineCount = new Set(targets.map(machineToken)).size
const expectedAgentTypes = [...new Set(targets
  .filter((target) => machineToken(target) === firstMachineToken)
  .map((target) => String(target.type)))]

if (!adminKey) throw new Error('A2S_ADMIN_KEY is required')
if (!Array.isArray(targets) || targets.length === 0) throw new Error('A2S_SMOKE_AGENTS must contain agent targets')

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
      partition: `a2s-console-smoke-${process.pid}`,
    },
  })

  const results = []
  let switchers = null
  try {
    await window.loadURL(consoleUrl)
    await waitFor(window, () => document.querySelector('.agentBrandMark--a2s'))
    results.push(await inspect(window, 'a2s'))
    await capture(window, join(outputDir, 'ui-a2s-login.png'))

    await window.webContents.executeJavaScript(`localStorage.setItem('a2sAdminKey', ${JSON.stringify(adminKey)})`)
    for (const target of targets) {
      await window.webContents.executeJavaScript(`localStorage.setItem('dshInstance', ${JSON.stringify(String(target.instanceId))})`)
      await window.loadURL(consoleUrl)
      await waitFor(window, (type) => {
        const sidebarType = document.querySelector('.brandMark .agentBrandMark')?.dataset.agentType
        const heroType = document.querySelector('.heroHeadline .agentBrandMark')?.dataset.agentType
        return sidebarType === type && heroType === type
          && !document.querySelector('.machineButton .mName')?.textContent?.includes('未选择')
      }, String(target.type))
      results.push(await inspect(window, String(target.type)))
      await capture(window, join(outputDir, `ui-${target.type}-brand.png`))
      if (!switchers && machineToken(target) === firstMachineToken) {
        switchers = await inspectSwitchers(window, {
          currentType: String(target.type),
          expectedMachineCount,
          expectedAgentTypes,
          outputDir,
        })
      }
    }

    console.log(JSON.stringify({ ok: true, consoleUrl, results, switchers, outputDir }))
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})

async function inspect(window, expectedType) {
  const result = await window.webContents.executeJavaScript(`(() => {
    const mark = document.querySelector('.brandMark .agentBrandMark')
    const heroMark = document.querySelector('.heroHeadline .agentBrandMark')
    const heroName = document.querySelector('.heroHeadline .heroAgentName')?.textContent || ''
    if (!mark) return null
    const box = mark.getBoundingClientRect()
    const style = getComputedStyle(mark)
    return {
      type: mark.dataset.agentType,
      width: box.width,
      height: box.height,
      square: box.width > 0 && Math.abs(box.width - box.height) < 0.25,
      maskImage: style.webkitMaskImage || style.maskImage || '',
      backgroundImage: style.backgroundImage || '',
      color: style.color,
      heroType: heroMark?.dataset.agentType || '',
      heroName,
      title: document.title,
    }
  })()`)
  const heroMatches = expectedType === 'a2s'
    ? true
    : result?.heroType === expectedType && Boolean(result?.heroName)
  if (!result || result.type !== expectedType || !heroMatches || !result.square) {
    throw new Error(`brand check failed for ${expectedType}: ${JSON.stringify(result)}`)
  }
  if (expectedType === 'a2s' ? !result.backgroundImage.includes('a2s-icon.png') : !result.maskImage.includes('/assets/brands/')) {
    throw new Error(`brand artwork missing for ${expectedType}: ${JSON.stringify(result)}`)
  }
  if (expectedType === 'dsh' && result.color !== 'rgb(0, 0, 0)') {
    throw new Error(`DSH brand mark must be black: ${JSON.stringify(result)}`)
  }
  return result
}

async function capture(window, path) {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  window.webContents.invalidate()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  const image = await window.capturePage()
  require('node:fs').writeFileSync(path, image.toPNG())
}

async function inspectSwitchers(window, { currentType, expectedMachineCount, expectedAgentTypes, outputDir }) {
  const machine = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.machineButton').click()
    return {
      title: document.querySelector('.menuCard .menuTitle')?.textContent || '',
      count: document.querySelectorAll('.menuCard .machineMenuItem').length,
      labels: [...document.querySelectorAll('.menuCard .machineMenuItem .miLabel')].map((node) => node.textContent),
      selected: document.querySelectorAll('.menuCard .machineMenuItem.selected').length,
      agentRows: document.querySelectorAll('.menuCard .agentMenuItem').length,
    }
  })()`)
  if (machine.count !== expectedMachineCount || machine.selected !== 1 || machine.agentRows !== 0 || !machine.title.includes('台机器')) {
    throw new Error(`machine switcher check failed: ${JSON.stringify(machine)}`)
  }
  await capture(window, join(outputDir, 'ui-machine-switcher.png'))

  // 选择当前机器必须保持当前 Agent 不变。
  await window.webContents.executeJavaScript(`document.querySelector('.menuCard .machineMenuItem.selected')?.click()`)
  await waitFor(window, (type) => document.querySelector('.brandMark .agentBrandMark')?.dataset.agentType === type, currentType)

  const agent = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('.brand').click()
    return {
      title: document.querySelector('.menuCard .menuTitle')?.textContent || '',
      count: document.querySelectorAll('.menuCard .agentMenuItem').length,
      types: [...document.querySelectorAll('.menuCard .agentMenuItem .agentBrandMark')].map((node) => node.dataset.agentType),
      selected: document.querySelectorAll('.menuCard .agentMenuItem.selected').length,
      machineRows: document.querySelectorAll('.menuCard .machineMenuItem').length,
      brandName: document.querySelector('.brandName')?.textContent?.trim() || '',
      brandHasContent: (document.querySelector('.brandName')?.childElementCount || 0) > 0,
      brandMarkType: document.querySelector('.brandMark .agentBrandMark')?.dataset.agentType || '',
    }
  })()`)
  const expectedTypes = [...expectedAgentTypes].sort()
  const actualTypes = [...agent.types].sort()
  if (agent.count !== expectedTypes.length || agent.selected !== 1 || agent.machineRows !== 0
      || !agent.title.includes('个智能体') || agent.brandMarkType !== currentType || !agent.brandHasContent
      || JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
    throw new Error(`agent switcher check failed: ${JSON.stringify(agent)}`)
  }
  await capture(window, join(outputDir, 'ui-agent-switcher.png'))

  const switchSequence = expectedAgentTypes.filter((type) => type !== currentType)
  const switchedThrough = []
  if (!switchSequence.length) {
    await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  } else {
    for (let index = 0; index < switchSequence.length; index += 1) {
      const type = switchSequence[index]
      if (index > 0) await window.webContents.executeJavaScript(`document.querySelector('.brand').click()`)
      await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`.menuCard .agentMenuItem--${type}`)})?.click()`)
      await waitFor(window, (next) => document.querySelector('.brandMark .agentBrandMark')?.dataset.agentType === next, type)
      switchedThrough.push(type)
    }
    await window.webContents.executeJavaScript(`document.querySelector('.brand').click()`)
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`.menuCard .agentMenuItem--${currentType}`)})?.click()`)
    await waitFor(window, (type) => document.querySelector('.brandMark .agentBrandMark')?.dataset.agentType === type, currentType)
  }
  return { machine, agent, switchedThrough, restoredTo: currentType }
}

function machineToken(target) {
  if (target?.deviceId) return String(target.deviceId)
  return String(target?.instanceId || '').replace(/:(?:claude(?:-code)?|codex|dsh|deepseek(?:-harness)?)$/i, '')
}

async function waitFor(window, predicate, argument) {
  const source = `(${predicate.toString()})(${JSON.stringify(argument)})`
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(source)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error(`timed out waiting for ${argument || 'console UI'}`)
}
