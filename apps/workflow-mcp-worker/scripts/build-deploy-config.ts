import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildWorkflowDeployConfig,
  readWorkflowDeployContext,
  type WranglerDeployConfig
} from '../src/deploy-config.js';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: build-deploy-config.ts <output-path>');

const source = JSON.parse(await readFile(sourcePath, 'utf8')) as WranglerDeployConfig;
const context = readWorkflowDeployContext(process.env);
const config = buildWorkflowDeployConfig(source, context);

await writeFile(outputPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`Wrote Workflow MCP Wrangler config for ${context.WORKFLOW_MCP_WORKER_NAME} from ${appRoot}.`);
