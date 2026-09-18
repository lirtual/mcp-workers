import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWorkflowText, generateRegistrySource } from '../src/compiler.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(appRoot, 'workflows');
const generatedPath = path.join(appRoot, 'src/generated/workflow-registry.ts');

const files = (await readdir(workflowsDir))
  .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'))
  .sort();

if (files.length === 0) throw new Error('At least one workflow definition is required.');

const entries = [];
const workflowIds = new Set<string>();
for (const file of files) {
  const sourcePath = `workflows/${file}`;
  const source = await readFile(path.join(workflowsDir, file), 'utf8');
  const entry = compileWorkflowText(source, sourcePath);
  if (workflowIds.has(entry.metadata.id)) {
    throw new Error(`Duplicate workflow id "${entry.metadata.id}".`);
  }
  workflowIds.add(entry.metadata.id);
  entries.push(entry);
}

const generated = generateRegistrySource(entries);
if (process.argv.includes('--validate')) {
  console.log(`Validated ${entries.length} workflow definition(s).`);
} else {
  await writeFile(generatedPath, generated, 'utf8');
  console.log(`Generated registry with ${entries.length} workflow definition(s).`);
}
