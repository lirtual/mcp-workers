/**
 * v2 device enrollment material. Only the device owns its private key and code.
 * This is preparation for an owner-reviewed pairing, NOT Shell authorization.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { open } from "node:fs/promises";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const ENROLLMENT_DOMAIN = "remote-control:v2:pending:";

export interface EnrollmentRequest {
  name: string;
  public_key: string;
  code_verifier: string;
  proof: string;
}

export function pairingVerifier(code: string): string {
  if (!/^[A-Z2-7]{10}$/.test(code)) throw new Error("Invalid pairing code.");
  return createHash("sha256").update(ENROLLMENT_DOMAIN + code).digest("hex");
}

export function newEnrollment(name: string): {
  code: string;
  privateKeyPem: string;
  request: EnrollmentRequest;
} {
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || /[\r\n\x00-\x1f]/.test(name)) {
    throw new Error("Invalid device label.");
  }
  // Each of 256 byte values maps to a Base32 symbol uniformly: 8 values/symbol.
  const code = [...randomBytes(10)].map((b) => ALPHABET[b & 31]).join("");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicSpki = Buffer.from(publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  const verifier = pairingVerifier(code);
  const transcript = Buffer.from(ENROLLMENT_DOMAIN + verifier + ":" + publicSpki + ":" + name);
  const proof = Buffer.from(sign(null, transcript, privateKey)).toString("base64");
  return {
    code,
    privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    request: { name, public_key: publicSpki, code_verifier: verifier, proof },
  };
}

export async function saveNewPrivateKey(filePath: string, pem: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(pem, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
