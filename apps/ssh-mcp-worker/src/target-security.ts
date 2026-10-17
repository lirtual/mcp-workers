function parseIpv4(value: string): number[] | null {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(part => part >= 0 && part <= 255) ? parts : null;
}

function parseIpv6(value: string): bigint | null {
  let input = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (input.includes('%') || !input.includes(':')) return null;
  if (input.includes('.')) {
    const split = input.lastIndexOf(':');
    const v4 = parseIpv4(input.slice(split + 1));
    if (!v4) return null;
    input = `${input.slice(0, split)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.reduce((acc, word) => (acc << 16n) | BigInt(`0x${word}`), 0n);
}

export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

export function normalizeDnsName(host: string): string | null {
  if (!host || /[\s\u0000-\u0020/@?#]/.test(host) || host.includes(':')) return null;
  try {
    const parsed = new URL(`http://${host}`);
    const name = parsed.hostname.toLowerCase();
    if (parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
        || name.length > 253 || name.endsWith('.')
        || !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(name)) return null;
    return name;
  } catch { return null; }
}

export function isPublicAddress(value: string): boolean {
  const v4 = parseIpv4(value);
  if (v4) {
    const [a, b, c] = v4 as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 0) || (a === 192 && b === 2)
      || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168)
      || (a === 192 && b === 31 && c === 196) || (a === 192 && b === 52 && c === 193)
      || (a === 192 && b === 175 && c === 48)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  const v6 = parseIpv6(value);
  if (v6 === null) return false;
  const first = Number(v6 >> 112n);
  const prefix23 = v6 >> 105n;
  const prefix48 = v6 >> 80n;
  const prefix20 = v6 >> 108n;
  return first >= 0x2000 && first <= 0x3fff
    && prefix23 !== 0x100080n
    && prefix48 !== 0x200100020000n
    && (v6 >> 32n) !== 0x20010db80000000000000000n
    && (v6 >> 112n) !== 0x2002n
    && prefix20 !== 0x3fff0n;
}
