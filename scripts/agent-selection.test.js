import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentChoicesForMachine,
  chooseInstanceForMachine,
  groupMachines,
  machineOfInstance,
} from '../public/js/agent-selection.js';

const instances = [
  { instanceId: 'laptop:claude', deviceId: 'laptop', label: 'Laptop', agentType: 'claude', online: true },
  { instanceId: 'laptop:codex', deviceId: 'laptop', label: 'Laptop', agentType: 'codex', online: true },
  { instanceId: 'laptop:dsh', deviceId: 'laptop', label: 'Laptop', agentType: 'dsh', online: false },
  { instanceId: 'desktop:claude', deviceId: 'desktop', label: 'Desktop', agentType: 'claude', online: true },
  { instanceId: 'desktop:codex', deviceId: 'desktop', label: 'Desktop', agentType: 'codex', online: false },
];

test('machine switcher groups agent instances by device', () => {
  const machines = groupMachines(instances);
  assert.equal(machines.length, 2);
  assert.deepEqual(machines.map((machine) => [machine.label, machine.instances.length]), [
    ['Laptop', 3],
    ['Desktop', 2],
  ]);
  assert.equal(machineOfInstance(instances, 'laptop:codex')?.key, 'device:laptop');
});

test('switching machines preserves the selected agent type when available', () => {
  const desktop = groupMachines(instances)[1];
  assert.equal(chooseInstanceForMachine(desktop, 'codex')?.instanceId, 'desktop:codex');
  assert.equal(chooseInstanceForMachine(desktop, 'dsh')?.instanceId, 'desktop:claude');
});

test('agent switcher keeps one entry per agent in stable brand order', () => {
  const laptop = groupMachines([
    ...instances,
    { instanceId: 'laptop:codex-backup', deviceId: 'laptop', label: 'Laptop', agentType: 'codex', online: false },
  ])[0];
  const choices = agentChoicesForMachine(laptop);
  assert.deepEqual(choices.map((choice) => choice.type), ['claude', 'codex', 'dsh']);
  assert.equal(choices.find((choice) => choice.type === 'codex')?.instance.instanceId, 'laptop:codex');
});
