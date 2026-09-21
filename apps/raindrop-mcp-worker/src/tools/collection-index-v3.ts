import { McpError } from "../types/mcpErrors.js";
import { EXECUTION_LIMITS } from "../services/execution-budget.js";

/** A bounded, deterministic hierarchy builder. Invalid ancestry is never
 * silently promoted into a root and a cycle is never traversed recursively. */
export type CollectionTreeNode<T> = T & {
  path: string[];
  children: CollectionTreeNode<T>[];
};

export function buildCollectionIndexV3<
  T extends { _id: number; title: string; count?: number; parent?: { $id?: number } },
>(collections: T[]) {
  let pathBytes = 0;
  const pathSizes = new Map<number, number>();
  const encoder = new TextEncoder();
  const records = new Map<number, CollectionTreeNode<T>>();
  for (const item of collections) {
    records.set(item._id, { ...item, path: [], children: [] });
  }
  const nodes = [...records.values()].sort((a, b) => a._id - b._id);
  const resolved = new Map<number, boolean>();
  const warnings = new Set<string>();
  for (const start of nodes) {
    if (resolved.has(start._id)) continue;
    const trace: CollectionTreeNode<T>[] = [];
    const encountered = new Set<number>();
    let cursor: CollectionTreeNode<T> | undefined = start;
    let valid = true;
    let prefix: string[] = [];
    let prefixBytes = 0;
    while (cursor) {
      const known = resolved.get(cursor._id);
      if (known !== undefined) {
        valid = known;
        prefix = valid ? cursor.path : [];
        prefixBytes = valid ? pathSizes.get(cursor._id)! : 0;
        break;
      }
      if (encountered.has(cursor._id)) {
        valid = false;
        warnings.add(`cycle:${cursor._id}`);
        break;
      }
      encountered.add(cursor._id);
      trace.push(cursor);
      const parentId = cursor.parent?.$id;
      if (parentId === undefined || parentId === null || parentId === 0) break;
      if (!Number.isSafeInteger(parentId) || parentId <= 0) {
        valid = false;
        warnings.add(`invalid-parent:${cursor._id}`);
        break;
      }
      cursor = records.get(parentId);
      if (!cursor) {
        valid = false;
        warnings.add(`missing-parent:${parentId}`);
        break;
      }
    }
    for (const node of trace.reverse()) {
      resolved.set(node._id, valid);
      const titleBytes = encoder.encode(JSON.stringify(node.title)).byteLength + 1;
      const bytes = (valid ? prefixBytes : 0) + titleBytes;
      pathBytes += bytes + 2;
      if (pathBytes > EXECUTION_LIMITS.resultBytes) {
        throw new McpError("RESOURCE_LIMIT", "Collection path expansion exceeds the result byte limit");
      }
      node.path = valid ? [...prefix, node.title] : [node.title];
      pathSizes.set(node._id, bytes);
      prefixBytes = bytes;
      prefix = node.path;
    }
  }

  const roots: CollectionTreeNode<T>[] = [];
  const unattached: CollectionTreeNode<T>[] = [];
  for (const node of nodes) {
    if (!resolved.get(node._id)) {
      unattached.push(node);
      continue;
    }
    const parentId = node.parent?.$id;
    if (parentId && records.has(parentId)) {
      records.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots, unattached, warnings: [...warnings].sort(), byId: records, nodes };
}

/** Descendants in stable order. The index is bounded by 1000 entries. */
export function descendantIdsV3<T extends { _id: number; title: string; count?: number; parent?: { $id?: number } }>(
  root: CollectionTreeNode<T>,
): number[] {
  const ids: number[] = [];
  const queue = [...root.children];
  const visited = new Set([root._id]);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    if (visited.has(node._id)) continue;
    visited.add(node._id);
    ids.push(node._id);
    queue.push(...node.children);
  }
  return ids.sort((a, b) => a - b);
}
