import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { KeyStore } from '../lib/keystore.js'
import { Relay } from '../lib/relay.js'

test('one A2S device key can bind three agent instances without being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'a2s-server-key-'))
  const store = new KeyStore(directory)
  const relay = new Relay({ offlineAfterMs: 90000 }, store)
  try {
    const key = `a2sk_${'a'.repeat(43)}`
    const entry = store.register(key, { label: 'test device', deviceId: 'device-1' })
    for (const type of ['dsh', 'claude', 'codex']) {
      relay.bindInstance({ instanceId: `device-1:${type}`, keyEntry: entry, label: 'test device' })
    }
    assert.deepEqual(store.list()[0].instanceIds, ['device-1:dsh', 'device-1:claude', 'device-1:codex'])
    assert.equal(relay.list().length, 3)
    assert.equal(store.findByInstanceId('device-1:codex')?.id, entry.id)
  } finally {
    relay.close()
    await rm(directory, { recursive: true, force: true })
  }
})
