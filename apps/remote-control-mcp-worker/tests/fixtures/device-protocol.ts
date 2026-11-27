// Synthetic signed request material and in-process Worker protocol fixtures.
// Native Agent enrollment/recovery and local safety are tested in Rust.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ENROLLMENT_DOMAIN = "remote-control:v2:pending:";

interface EnrollmentRequest {
  name: string;
  public_key: string;
  code_verifier: string;
  proof: string;
  issued_at: number;
  grant_type?: "temporary"; // Omitted for permanent grant
  pairing_protocol: "single-code-v1"; // Signed enrollment version; old pending cannot be silently approved
}

function pairingVerifier(code: string): string {
  if (!/^[A-Z2-7]{10}$/.test(code)) throw new Error("Invalid pairing code.");
  return createHash("sha256").update(ENROLLMENT_DOMAIN + code).digest("hex");
}

export function newEnrollment(name: string, existingPrivateKeyPem?: string, grantType: "permanent" | "temporary" = "permanent"): {
  code: string;
  privateKeyPem: string;
  request: EnrollmentRequest;
} {
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || /[\r\n\x00-\x1f]/.test(name)) {
    throw new Error("Invalid device label.");
  }
  if (!["permanent", "temporary"].includes(grantType)) throw new Error("Invalid grant type.");
  // Each of 256 byte values maps to a Base32 symbol uniformly: 8 values/symbol.
  const code = [...randomBytes(10)].map((b) => ALPHABET[b & 31]).join("");
  // Use the same synthetic identity for repeated pending requests.
  const privateKey = existingPrivateKeyPem
    ? createPrivateKey(existingPrivateKeyPem)
    : generateKeyPairSync("ed25519").privateKey;
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Only Ed25519 device identity is supported.");
  const publicKey = createPublicKey(privateKey);
  const publicSpki = Buffer.from(publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  const verifier = pairingVerifier(code);
  const issuedAt = Date.now();
  const transcript = Buffer.from(ENROLLMENT_DOMAIN + verifier + ":" + publicSpki + ":" + name + ":" + issuedAt + (grantType === "temporary" ? ":temporary" : "") + ":single-code-v1");
  const proof = Buffer.from(sign(null, transcript, privateKey)).toString("base64");
  return {
    code,
    privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
    request: { name, public_key: publicSpki, code_verifier: verifier, proof, issued_at: issuedAt,
      pairing_protocol: "single-code-v1",
      ...(grantType === "temporary" ? { grant_type: "temporary" as const } : {}) },
  };
}

export async function saveNewPrivateKey(filePath: string, pem: string): Promise<void> {
  await writeFile(filePath, pem, { flag: "wx", mode: 0o600 });
}

export function signedSessionProof(pem: string, deviceId: string, nonce: string) {
  const key = createPrivateKey(pem);
  const public_key = Buffer.from(createPublicKey(key).export({ type: "spki", format: "der" })).toString("base64");
  const proof = Buffer.from(sign(null, Buffer.from(`remote-control:v2:session:${deviceId}:${nonce}:${public_key}`), key)).toString("base64url");
  return { proof, public_key };
}

// Mandatory injected Worker transport: these fixtures cannot initiate a
// network session, install an Agent or perform real device pairing.
export async function recoverDeviceId(origin: string, keyPath: string, send: typeof fetch): Promise<string> {
  const pem = await readFile(keyPath, "utf8");
  const public_key = Buffer.from(createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" })).toString("base64");
  const post = (route: string, body: object) => send(new URL(route, origin), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const challenge = await post("/agent/session/challenge", { public_key });
  if (challenge.status !== 200) throw Error("No approved device identity matches this key.");
  const {device_id, nonce} = await challenge.json() as {device_id: string; nonce: string};
  const {proof} = signedSessionProof(pem, device_id, nonce);
  const response = await post("/agent/session/recover", {device_id, nonce, proof});
  if (response.status !== 200) throw Error("Signed device identity recovery failed.");
  const result = await response.json() as {status: string; device_id: string};
  if (result.status !== "verified" || result.device_id !== device_id) throw Error("Signed device identity recovery failed.");
  try {
    await writeFile(keyPath + ".device-id", device_id + "\n", {flag: "wx", mode: 0o600});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(keyPath + ".device-id", "utf8")).trim() !== device_id)
      throw Error("Device ID on disk does not match authenticated identity.");
  }
  return device_id;
}
