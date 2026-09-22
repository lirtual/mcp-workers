import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { compileWorkflowText, generateRegistrySource, type TrustedCompilePolicy } from '../src/compiler.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultWorkflowsDir = path.join(appRoot, 'workflows');
const generatedPath = path.join(appRoot, 'src/generated/workflow-registry.ts');

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return value;
}

const externalDir = readFlag('--workflows-dir');
const policyFile = readFlag('--policy-snapshot');
const outputFile = readFlag('--output');
const validateOnly = process.argv.includes('--validate');
const workflowsDir = externalDir ? path.resolve(externalDir) : defaultWorkflowsDir;

if (externalDir && !policyFile) {
  throw new Error('An external catalog requires an explicit trusted policy snapshot.');
}
if ((externalDir || policyFile) && !validateOnly && !outputFile) {
  throw new Error('External policy compilation requires --output; refusing to replace the bundled registry.');
}

const policySchema = z.object({
  revision: z.number().int().nonnegative(),
  connections: z.record(z.string(), z.object({
    tools: z.record(z.string(), z.object({
      effect: z.enum(['read', 'idempotent_write', 'unsafe_write', 'unknown']),
      operationIdArgument: z.string().optional()
    }).strict()),
    version: z.number().int().positive().optional(),
    enabled: z.boolean().optional()
  }).strict()),
  webhookBindings: z.array(z.object({
    workflowId: z.string(), triggerId: z.string(), referenceId: z.string()
  }).strict()).max(64).optional()
}).strict();

const policy: TrustedCompilePolicy | undefined = policyFile
  ? policySchema.parse(JSON.parse(await readFile(path.resolve(policyFile), 'utf8')))
  : undefined;

const files = (await readdir(workflowsDir))
  .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'))
  .sort();

if (files.length === 0) throw new Error('At least one workflow definition is required.');

const entries = [];
const workflowIds = new Set<string>();
for (const file of files) {
  const sourcePath = `workflows/${file}`;
  const source = await readFile(path.join(workflowsDir, file), 'utf8');
  const entry = compileWorkflowText(source, sourcePath, policy);
  if (workflowIds.has(entry.metadata.id)) {
    throw new Error(`Duplicate workflow id "${entry.metadata.id}".`);
  }
  workflowIds.add(entry.metadata.id);
  entries.push(entry);
}

const generated = generateRegistrySource(entries);
if (validateOnly) {
  console.log(`Validated ${entries.length} workflow definition(s).`);
} else {
  await writeFile(outputFile ? path.resolve(outputFile) : generatedPath, generated, 'utf8');
  console.log(`Generated registry with ${entries.length} workflow definition(s).`);
}
