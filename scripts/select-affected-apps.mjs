import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPLICATIONS = [
  'database-mcp-worker',
  'ima-mcp-worker',
  'raindrop-mcp-worker',
  'remote-control-mcp-worker',
  'ssh-mcp-worker',
];

const RELEASE_WORKERS = APPLICATIONS.filter(app => app !== 'ssh-mcp-worker');

function requiresAllApps(file) {
  return file === 'package.json'
    || file === 'pnpm-lock.yaml'
    || file === 'pnpm-workspace.yaml'
    || file === '.npmrc'
    || file.startsWith('packages/')
    || file === '.github/workflows/ci.yml'
    || file.startsWith('scripts/select-affected-apps')
    || file.startsWith('scripts/manual-worker-release');
}

export function selectAffectedApps(changedFiles) {
  if (changedFiles.some(requiresAllApps)) return [...APPLICATIONS];
  return APPLICATIONS.filter(app => changedFiles.some(file => file.startsWith(`apps/${app}/`)));
}

export function selectionDetails(changedFiles) {
  const apps = selectAffectedApps(changedFiles);
  const checkAll = changedFiles.some(requiresAllApps);
  const remoteControlChanged = checkAll || changedFiles.some(file =>
    file.startsWith('apps/remote-control-agent/') || file.startsWith('apps/remote-control-mcp-worker/'));
  return {
    apps,
    databaseChanged: apps.includes('database-mcp-worker'),
    portalAuthChanged: changedFiles.some(file => file.startsWith('packages/portal-auth/')),
    remoteControlChanged,
  };
}

function changedFilesForCurrentEvent(env) {
  if (env.EVENT_NAME === 'workflow_dispatch') return [];
  const base = env.EVENT_NAME === 'pull_request' ? env.PR_BASE_SHA : env.BEFORE_SHA;
  if (!base || /^0+$/.test(base)) {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', env.GITHUB_SHA], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  }
  return execFileSync('git', ['diff', '--name-only', base, env.GITHUB_SHA], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

function main(env = process.env) {
  let selected;
  let changedFiles;
  if (env.EVENT_NAME === 'workflow_dispatch') {
    if (env.MANUAL_REF !== 'refs/heads/main' || !RELEASE_WORKERS.includes(env.MANUAL_WORKER)) {
      throw new Error(`Unsupported manual Worker selection: ${env.MANUAL_WORKER ?? ''}`);
    }
    selected = [env.MANUAL_WORKER];
    changedFiles = [];
  } else {
    changedFiles = changedFilesForCurrentEvent(env);
    selected = selectAffectedApps(changedFiles);
  }

  process.stdout.write(`Changed files:\n${changedFiles.map(file => `  ${file}\n`).join('')}`);
  const details = selectionDetails(changedFiles);
  details.apps = selected;
  details.databaseChanged = selected.includes('database-mcp-worker');
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, [
      `apps=${selected.join(' ')}`,
      `portal_auth_changed=${details.portalAuthChanged}`,
      `database_changed=${details.databaseChanged}`,
      `remote_control_changed=${details.remoteControlChanged}`,
    ].join('\n') + '\n');
  }
  process.stdout.write(selected.length ? `Selected applications: ${selected.join(' ')}\n` : 'No application checks are required for this change set.\n');
  process.stdout.write(`Portal auth package changed: ${details.portalAuthChanged}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
