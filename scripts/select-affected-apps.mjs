import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPLICATIONS = [
  'database-mcp-worker',
  'github-actions-mcp-worker',
  'ima-mcp-worker',
  'raindrop-mcp-worker',
  'remote-control-mcp-worker',
  'ssh-mcp-worker',
  'workflow-mcp-worker',
];

// Only the selected main-branch manual workflow may deploy; CI never deploys.
const RELEASE_WORKERS = APPLICATIONS;

function requiresAllApps(file) {
  return file === 'package.json'
    || file === 'pnpm-lock.yaml'
    || file === 'pnpm-workspace.yaml'
    || file === '.npmrc'
    || file.startsWith('packages/')
    || ['ci.yml', 'release.yml', 'acceptance.yml'].some(name => file === '.github/workflows/' + name)
    || file.startsWith('scripts/select-affected-apps')
    || file.startsWith('scripts/manual-worker-release')
    || file.startsWith('scripts/bootstrap-worker-secrets')
    || file.startsWith('scripts/worker-release-variables');
}

export function selectAffectedApps(changedFiles) {
  if (changedFiles.some(requiresAllApps)) return [...APPLICATIONS];
  return APPLICATIONS.filter(app => changedFiles.some(file =>
    file.startsWith(`apps/${app}/`) || (app === 'remote-control-mcp-worker' && file === 'scripts/stage-public-remote-control-agent.sh')));
}

export function selectionDetails(changedFiles) {
  const apps = selectAffectedApps(changedFiles);
  const checkAll = changedFiles.some(requiresAllApps);
  const remoteControlChanged = checkAll || changedFiles.some(file =>
    file.startsWith('apps/remote-control-agent/') || file.startsWith('apps/remote-control-mcp-worker/') || file === 'scripts/stage-public-remote-control-agent.sh');
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
  if (env.REUSABLE_WORKER) {
    if (!RELEASE_WORKERS.includes(env.REUSABLE_WORKER)) {
      throw new Error(`Unsupported reusable Worker selection: ${env.REUSABLE_WORKER}`);
    }
    selected = [env.REUSABLE_WORKER];
    changedFiles = [];
  } else if (env.EVENT_NAME === 'workflow_dispatch') {
    const production = env.MANUAL_REF === 'refs/heads/main'
      && RELEASE_WORKERS.includes(env.MANUAL_WORKER);
    if (!production) {
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
  if (env.REUSABLE_WORKER === 'remote-control-mcp-worker' ||
      (env.EVENT_NAME === 'workflow_dispatch' && env.MANUAL_WORKER === 'remote-control-mcp-worker')) {
    details.remoteControlChanged = true;
  }
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
