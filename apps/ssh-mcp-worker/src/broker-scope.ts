/**
 * Initial CloudCone G5 smoke scope. With a configured Service Binding this
 * stays fail-closed until a SEPARATELY approved full-access release.
 */
export function isBrokerReadOnlyToolCall(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const rpc = input as Record<string, unknown>;
  if (rpc.method !== 'tools/call') return true;
  const params = rpc.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const { name, arguments: raw } = params as Record<string, unknown>;
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  switch (name) {
    case 'list_hosts':
    case 'get_host':
    case 'get_operation_status':
      return true;
    case 'ssh_exec':
      return args.command === 'pwd' || args.command === 'printf G5_SSH_OK';
    case 'sftp_list':
      return args.path === '/etc';
    case 'sftp_read_text':
      return args.path === '/etc/hostname';
    default:
      return false;
  }
}
