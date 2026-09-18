import { getExecutionManifest, type ExecutionManifest } from './executor-protocol.js';
import { presignR2Url } from './r2-signing.js';
import {
  D1WorkflowStore,
  type ArtifactAllocationInput,
  type ArtifactRecord
} from './storage.js';
import type { Env } from './types.js';

const UPLOAD_EXPIRY_SECONDS = 300;
const READ_EXPIRY_SECONDS = 300;
const MAX_ARCHIVE_BYTES = 1024 * 1024;

export interface ArtifactStore {
  getArtifactByAttemptName(attemptId: string, name: string): Promise<ArtifactRecord | null>;
  getOrCreateArtifactAllocation(input: ArtifactAllocationInput): Promise<ArtifactRecord>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  finalizeArtifact(artifactId: string, size: number, sha256: string): Promise<ArtifactRecord>;
  listArtifacts(runId: string): Promise<ArtifactRecord[]>;
}

export interface ArtifactUploadAllocationRequest {
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface ArtifactUploadAllocation {
  artifactId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresInSeconds: number;
}

export interface ArtifactReference {
  artifactId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface ArtifactReadReference extends ArtifactReference {
  readUrl: string;
  readUrlExpiresInSeconds: number;
}

export async function allocateArtifactUpload(
  env: Env,
  lease: string,
  request: ArtifactUploadAllocationRequest,
  options: { store?: ArtifactStore; now?: Date } = {}
): Promise<ArtifactUploadAllocation> {
  const manifest = await getExecutionManifest(env, lease);
  validateArtifactAllocationForManifest(manifest, request);

  const store = options.store ?? new D1WorkflowStore(env.DB);
  const existing = await store.getArtifactByAttemptName(manifest.attemptId, request.name);
  const proposedArtifactId = `artifact_${crypto.randomUUID()}`;
  const artifact = await store.getOrCreateArtifactAllocation({
    artifactId: proposedArtifactId,
    runId: manifest.runId,
    stepRunId: manifest.stepRunId,
    attemptId: manifest.attemptId,
    objectKey: artifactObjectKey(
      manifest.runId,
      manifest.stepRunId,
      manifest.attemptId,
      proposedArtifactId,
      request.name
    ),
    name: request.name,
    mediaType: request.mediaType,
    expectedSize: request.size,
    expectedSha256: request.sha256
  });

  if (
    existing &&
    (
      existing.expectedSize !== request.size ||
      existing.expectedSha256 !== request.sha256 ||
      existing.mediaType !== request.mediaType
    )
  ) {
    throw new Error('Existing Artifact allocation does not match retry metadata.');
  }

  const requiredHeaders = {
    'Content-Type': artifact.mediaType,
    'x-amz-meta-artifact-id': artifact.artifactId,
    'x-amz-meta-sha256': artifact.expectedSha256
  };
  const uploadUrl = await presignR2Url(env, {
    method: 'PUT',
    key: artifact.objectKey,
    expiresInSeconds: UPLOAD_EXPIRY_SECONDS,
    headers: requiredHeaders,
    ...(options.now ? { now: options.now } : {})
  });

  return {
    artifactId: artifact.artifactId,
    uploadUrl,
    requiredHeaders,
    expiresInSeconds: UPLOAD_EXPIRY_SECONDS
  };
}

export async function finalizeCallbackArtifacts(
  env: Env,
  lease: string,
  result: Record<string, unknown>,
  options: { store?: ArtifactStore } = {}
): Promise<Record<string, unknown>> {
  if (result.state !== 'succeeded') return result;

  const manifest = await getExecutionManifest(env, lease);
  if (manifest.capability !== 'github.archive_markdown') return result;

  const output = objectField(result, 'output');
  const artifactInput = objectField(output, 'artifact');
  const artifactId = stringField(artifactInput, 'artifactId');
  const name = stringField(artifactInput, 'name');
  const mediaType = stringField(artifactInput, 'mediaType');
  const sha256 = stringField(artifactInput, 'sha256').toLowerCase();
  const size = integerField(artifactInput, 'size');
  const sourceUrl = stringField(artifactInput, 'sourceUrl');

  validateArtifactAllocationForManifest(manifest, {
    name,
    mediaType,
    size,
    sha256
  });

  const store = options.store ?? new D1WorkflowStore(env.DB);
  const artifact = await store.getArtifact(artifactId);
  if (!artifact) throw new Error('Artifact allocation was not found.');
  if (
    artifact.attemptId !== manifest.attemptId ||
    artifact.runId !== manifest.runId ||
    artifact.stepRunId !== manifest.stepRunId ||
    artifact.name !== name ||
    artifact.mediaType !== mediaType ||
    artifact.expectedSize !== size ||
    artifact.expectedSha256 !== sha256
  ) {
    throw new Error('Artifact callback metadata does not match the server allocation.');
  }

  const object = await env.ARTIFACTS.head(artifact.objectKey);
  if (!object) throw new Error('Allocated R2 Artifact object does not exist.');
  if (object.size !== size) throw new Error('R2 Artifact size does not match the allocation.');
  if (object.httpMetadata?.contentType !== mediaType) {
    throw new Error('R2 Artifact content type does not match the allocation.');
  }
  if (
    object.customMetadata?.sha256 !== sha256 ||
    object.customMetadata?.['artifact-id'] !== artifactId
  ) {
    throw new Error('R2 Artifact signed metadata does not match the allocation.');
  }

  const finalized = await store.finalizeArtifact(artifactId, size, sha256);
  const reference = artifactReference(finalized);

  return {
    state: 'succeeded',
    output: {
      artifact: {
        ...reference,
        sourceUrl
      }
    }
  };
}

export async function artifactReadReferences(
  env: Env,
  runId: string,
  options: { store?: ArtifactStore; now?: Date } = {}
): Promise<ArtifactReadReference[]> {
  const store = options.store ?? new D1WorkflowStore(env.DB);
  const artifacts = await store.listArtifacts(runId);
  return Promise.all(
    artifacts.map(async artifact => ({
      ...artifactReference(artifact),
      readUrl: await presignR2Url(env, {
        method: 'GET',
        key: artifact.objectKey,
        expiresInSeconds: READ_EXPIRY_SECONDS,
        ...(options.now ? { now: options.now } : {})
      }),
      readUrlExpiresInSeconds: READ_EXPIRY_SECONDS
    }))
  );
}

export function artifactObjectKey(
  runId: string,
  stepRunId: string,
  attemptId: string,
  artifactId: string,
  name: string
): string {
  for (const [label, value] of Object.entries({
    runId,
    stepRunId,
    attemptId,
    artifactId,
    name
  })) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
      throw new Error(`Artifact ${label} contains unsupported key characters.`);
    }
  }
  return `runs/${runId}/steps/${stepRunId}/attempts/${attemptId}/artifacts/${artifactId}/${name}`;
}

function validateArtifactAllocationForManifest(
  manifest: ExecutionManifest,
  request: ArtifactUploadAllocationRequest
): void {
  if (manifest.capability !== 'github.archive_markdown') {
    throw new Error(`Capability "${manifest.capability}" cannot allocate an Artifact in v0.1.`);
  }
  if (request.name !== 'archive.md' || request.mediaType !== 'text/markdown') {
    throw new Error('github.archive_markdown may allocate only archive.md as text/markdown.');
  }
  if (!Number.isInteger(request.size) || request.size < 0 || request.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive.md size must be between 0 and ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  if (!/^[a-f0-9]{64}$/.test(request.sha256)) {
    throw new Error('Artifact sha256 must be a lowercase 64-character hex digest.');
  }
}

function artifactReference(artifact: ArtifactRecord): ArtifactReference {
  if (artifact.state !== 'ready' || artifact.size === undefined || artifact.sha256 === undefined) {
    throw new Error('Artifact is not ready.');
  }
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    mediaType: artifact.mediaType,
    size: artifact.size,
    sha256: artifact.sha256
  };
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw new Error(`Artifact callback field "${key}" must be an object.`);
  }
  return field as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0 || field.length > 500) {
    throw new Error(`Artifact callback field "${key}" must be a bounded string.`);
  }
  return field;
}

function integerField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isInteger(field)) {
    throw new Error(`Artifact callback field "${key}" must be an integer.`);
  }
  return field;
}
