export type Approval = {pairing_id:string; expected_fingerprint:string; expected_grant_type:"permanent"|"temporary"};

export function pairingCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z2-7]{10}$/.test(value);
}

export function approvalArgs(input: unknown): Approval | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const args=input as Record<string,unknown>;
  if (Object.keys(args).length !== 3 ||
      !["pairing_id","expected_fingerprint","expected_grant_type"].every(key => Object.hasOwn(args,key)) ||
      typeof args.pairing_id !== "string" || typeof args.expected_fingerprint !== "string" ||
      (args.expected_grant_type !== "permanent" && args.expected_grant_type !== "temporary")) return null;
  return {pairing_id:args.pairing_id,expected_fingerprint:args.expected_fingerprint,expected_grant_type:args.expected_grant_type};
}

export async function lookupOwnerPairing(owner: DurableObjectStub, code: string): Promise<Response> {
  const value = new TextEncoder().encode("remote-control:v2:pending:" + code);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  const verifier = [...bytes].map(x => x.toString(16).padStart(2,"0")).join("");
  return owner.fetch("https://device.internal/lookup",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({verifier}),
  });
}

export function approveOwnerPairing(owner: DurableObjectStub, args: Approval): Promise<Response> {
  return owner.fetch("https://device.internal/approve",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(args),
  });
}
