export type EffectClass = 'read' | 'idempotent_write' | 'unsafe_write' | 'unknown';
export type ExecutorType = 'cloudflare' | 'github';

export interface StaticCapabilityDescriptor {
  name: string;
  allowedInputs: ReadonlySet<string>;
  executor: ExecutorType;
  effect: EffectClass;
  maxAutomaticAttempts: number;
  defaultAutomaticAttempts: number;
}

const descriptors = {
  'http.read': {
    name: 'http.read',
    allowedInputs: new Set(['url']),
    executor: 'cloudflare',
    effect: 'read',
    maxAutomaticAttempts: 3,
    defaultAutomaticAttempts: 1
  },
  'mcp.call': {
    name: 'mcp.call',
    allowedInputs: new Set(['connection', 'tool', 'arguments']),
    executor: 'cloudflare',
    effect: 'unknown',
    maxAutomaticAttempts: 3,
    defaultAutomaticAttempts: 1
  },
  'github.archive_markdown': {
    name: 'github.archive_markdown',
    allowedInputs: new Set(['content', 'source_url']),
    executor: 'github',
    effect: 'unsafe_write',
    maxAutomaticAttempts: 1,
    defaultAutomaticAttempts: 1
  }
} as const satisfies Record<string, StaticCapabilityDescriptor>;

export type CapabilityName = keyof typeof descriptors;

export function getCapabilityDescriptor(name: string): StaticCapabilityDescriptor | undefined {
  return descriptors[name as CapabilityName];
}

export function getAutomaticAttemptLimit(
  name: string,
  requestedAttempts: number | undefined
): number {
  const descriptor = getCapabilityDescriptor(name);
  if (!descriptor) throw new Error(`Unknown capability "${name}".`);
  const attempts = requestedAttempts ?? descriptor.defaultAutomaticAttempts;
  if (attempts < 1 || attempts > descriptor.maxAutomaticAttempts) {
    throw new Error(
      `Capability "${name}" permits at most ${descriptor.maxAutomaticAttempts} automatic attempt(s).`
    );
  }
  return attempts;
}
