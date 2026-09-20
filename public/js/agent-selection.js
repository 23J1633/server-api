/** 多 Agent 控制台的机器/Agent 两级选择模型。纯函数便于浏览器与 Node 测试共用。 */

const AGENT_ORDER = Object.freeze(['claude', 'codex', 'dsh', 'a2s']);

export function normalizeAgentType(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'deepseek' || type === 'deepseek-harness') return 'dsh';
  if (type === 'claude-code') return 'claude';
  return ['dsh', 'claude', 'codex'].includes(type) ? type : 'a2s';
}

export function agentDisplayName(type) {
  return ({
    dsh: 'DeepSeek Harness',
    claude: 'Claude Code',
    codex: 'Codex',
    a2s: 'A2S Console',
  })[normalizeAgentType(type)] || 'A2S Console';
}

/**
 * 优先使用插件上报的 deviceId；旧插件再依次按 key 指纹和 instanceId 前缀归组。
 */
export function machineKeyOf(instance) {
  if (instance?.deviceId) return `device:${instance.deviceId}`;
  if (instance?.keyFingerprint) return `key:${instance.keyFingerprint}`;
  const instanceId = String(instance?.instanceId || 'unknown');
  const base = instanceId.replace(/:(?:claude(?:-code)?|codex|dsh|deepseek(?:-harness)?)$/i, '');
  return `instance:${base}`;
}

export function machineLabelOf(instance) {
  return String(
    instance?.label
      || instance?.hostname
      || instance?.displayName
      || instance?.deviceId
      || instance?.instanceId
      || '未命名机器',
  );
}

export function groupMachines(instances = []) {
  const machines = new Map();
  for (const instance of instances) {
    const key = machineKeyOf(instance);
    let machine = machines.get(key);
    if (!machine) {
      machine = { key, label: machineLabelOf(instance), instances: [] };
      machines.set(key, machine);
    }
    machine.instances.push(instance);
    if ((!machine.label || machine.label === '未命名机器') && machineLabelOf(instance)) {
      machine.label = machineLabelOf(instance);
    }
  }
  return [...machines.values()];
}

export function machineOfInstance(instances, instanceId) {
  const current = instances.find((instance) => instance.instanceId === instanceId);
  if (!current) return null;
  const key = machineKeyOf(current);
  return groupMachines(instances).find((machine) => machine.key === key) || null;
}

/** 切换机器时保留当前 Agent 类型；目标机器没有该 Agent 时再回退到在线实例。 */
export function chooseInstanceForMachine(machine, preferredType) {
  const instances = machine?.instances || [];
  const type = normalizeAgentType(preferredType);
  return instances.find((instance) => normalizeAgentType(instance.agentType) === type && instance.online)
    || instances.find((instance) => normalizeAgentType(instance.agentType) === type)
    || instances.find((instance) => instance.online)
    || instances[0]
    || null;
}

/** 每种 Agent 只给一个入口，在线实例优先，并固定为 Claude/Codex/DSH 顺序。 */
export function agentChoicesForMachine(machine) {
  const choices = new Map();
  for (const instance of machine?.instances || []) {
    const type = normalizeAgentType(instance.agentType);
    const current = choices.get(type);
    if (!current || (!current.online && instance.online)) choices.set(type, instance);
  }
  return [...choices.entries()]
    .sort(([left], [right]) => AGENT_ORDER.indexOf(left) - AGENT_ORDER.indexOf(right))
    .map(([type, instance]) => ({ type, instance }));
}
