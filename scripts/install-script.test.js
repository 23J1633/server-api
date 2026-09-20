import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = path.join(ROOT, 'install.sh')

test('one-line installer preserves data and configures a restartable systemd service', async () => {
  const source = await readFile(INSTALLER, 'utf8')
  assert.equal(source.includes('\r'), false, 'installer must use LF line endings')
  for (const required of [
    'https://github.com/23J1633/server-api',
    'A2S_SERVER_DATA_DIR',
    'npm --prefix "$stage" ci --omit=dev',
    'Restart=always',
    'systemctl enable',
    'wait_for_health',
    'Deployment rolled back',
    'Admin key file',
    '--uninstall',
    '--purge',
    'systemctl disable --now',
    'Preserved keys',
  ]) assert.ok(source.includes(required), `missing installer behavior: ${required}`)
})

test('one-line installer passes Bash parsing and dry-run validation', async (context) => {
  const bash = await findBash()
  if (!bash) {
    context.skip('Bash is not available on this machine')
    return
  }
  const syntax = spawnSync(bash, ['-n', INSTALLER], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout)
  const dryRun = spawnSync(bash, [INSTALLER, '--dry-run'], { encoding: 'utf8' })
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout)
  assert.match(dryRun.stdout, /Dry run complete/)
  assert.match(dryRun.stdout, /127\.0\.0\.1:50443/)

  const uninstallDryRun = spawnSync(bash, [INSTALLER, '--uninstall', '--dry-run'], { encoding: 'utf8' })
  assert.equal(uninstallDryRun.status, 0, uninstallDryRun.stderr || uninstallDryRun.stdout)
  assert.match(uninstallDryRun.stdout, /Uninstall plan/)
  assert.match(uninstallDryRun.stdout, /purge data : 0/)

  const purgeDryRun = spawnSync(bash, [INSTALLER, '--uninstall', '--purge', '--dry-run'], { encoding: 'utf8' })
  assert.equal(purgeDryRun.status, 0, purgeDryRun.stderr || purgeDryRun.stdout)
  assert.match(purgeDryRun.stdout, /purge data : 1/)

  const overlappingPaths = spawnSync(bash, [INSTALLER, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, A2S_INSTALL_DIR: '/opt/a2s', A2S_SERVER_DATA_DIR: '/opt/a2s/data' },
  })
  assert.notEqual(overlappingPaths.status, 0)
  assert.match(overlappingPaths.stderr, /must not overlap/)
})

test('successful-install summary prints banner, administrator key, path, and uninstall commands', async (context) => {
  const bash = await findBash()
  if (!bash) {
    context.skip('Bash is not available on this machine')
    return
  }
  const root = await mkdtemp(path.join(tmpdir(), 'a2s-installer-output-'))
  const dataDir = path.join(root, 'data')
  const envFile = path.join(root, 'a2s-server.env')
  const fakeKey = 'a2sadm_test_only_not_a_real_secret'
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'admin-key.txt'), `${fakeKey}\n`)
  await writeFile(envFile, `A2S_SERVER_PORT=50443\nA2S_SERVER_NO_TLS=1\nA2S_SERVER_DATA_DIR=${toBashPath(dataDir)}\n`)
  try {
    const result = spawnSync(bash, ['-c', 'set --; source "$A2S_INSTALLER_PATH"; finish'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        A2S_INSTALLER_SOURCE_ONLY: '1',
        A2S_INSTALLER_PATH: toBashPath(INSTALLER),
        A2S_ENV_FILE: toBashPath(envFile),
        A2S_SERVER_DATA_DIR: toBashPath(dataDir),
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /_\s+____\s+____/)
    assert.match(result.stdout, new RegExp(fakeKey))
    assert.match(result.stdout, /Admin key file/)
    assert.match(result.stdout, /--uninstall/)
    assert.match(result.stdout, /--uninstall --purge/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function findBash() {
  const candidates = process.platform === 'win32'
    ? ['D:\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']
    : ['/usr/bin/bash', '/bin/bash']
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* continue */ }
  }
  return null
}

function toBashPath(value) {
  if (process.platform !== 'win32') return value
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (!match) return value.replaceAll('\\', '/')
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
}
