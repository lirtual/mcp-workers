/**
 * The first reviewed MCP write operation. Source review, not upstream annotations,
 * decides which external side effects this Workflow may execute.
 *
 * Only an owner-approved, immutable literal IMA note body is supported.
 * No folder routing, dynamic inputs, arbitrary tool names or foreach writes.
 */
// One-MCP namespaces the IMA upstream create_note as ima_create_note.
// Raw create_note is not a valid trusted Portal action identity.
export const REVIEWED_WRITE_TOOL = 'ima_create_note';
export const MAX_NOTE_CONTENT_LENGTH = 2048;

export function reviewedWriteArguments(value: unknown): value is {content:string} {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const args=value as Record<string,unknown>;
  return Object.keys(args).length===1 &&
    Object.hasOwn(args,'content') &&
    typeof args.content==='string' &&
    args.content.trim().length>0 &&
    args.content.length<=MAX_NOTE_CONTENT_LENGTH;
}

export function reviewedWriteTool(tool: {
  name?:unknown;
  inputSchema?:unknown;
  annotations?:{readOnlyHint?:boolean;destructiveHint?:boolean};
}): boolean {
  if(tool.name!==REVIEWED_WRITE_TOOL ||
    tool.annotations?.readOnlyHint!==false ||
    tool.annotations?.destructiveHint!==false)return false;
  const schema=tool.inputSchema as {
    type?:unknown;
    properties?:Record<string,{type?:unknown;minLength?:unknown}>;
    required?:unknown;
  }|undefined;
  if(schema?.type!=='object' || !schema.properties ||
    typeof schema.properties!=='object'||Array.isArray(schema.properties) ||
    !Array.isArray(schema.required) ||
    schema.required.length!==1 || schema.required[0]!=='content')return false;
  if(Object.keys(schema.properties).some(k=>!['content','folder_id','folder_name'].includes(k)))
    return false;
  if(schema.properties.content?.type!=='string' ||
    schema.properties.content?.minLength!==1)return false;
  return ['folder_id','folder_name'].every(k=>
    schema.properties?.[k]===undefined || schema.properties[k]?.type==='string');
}
