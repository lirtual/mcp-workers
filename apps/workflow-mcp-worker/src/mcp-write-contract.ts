/**
 * Source-reviewed MCP write tools only. Upstream annotations never grant rights.
 * One-MCP prefixes IMA tool names. Each write needs a literal bounded body,
 * an exact pinned schema grant, owner write approval and a one-shot D1 fence.
 * No arbitrary write tools, folder routing, dynamic refs or foreach writes.
 */
export const REVIEWED_WRITE_TOOL='ima_create_note';
export const REVIEWED_APPEND_TOOL='ima_append_note';
export const REVIEWED_WRITE_TOOLS=[REVIEWED_WRITE_TOOL,REVIEWED_APPEND_TOOL] as const;
export const MAX_NOTE_CONTENT_LENGTH=2048;
const NOTE_ID=/^[0-9]{8,24}$/;

export function reviewedWriteArguments(value:unknown,tool:string=REVIEWED_WRITE_TOOL):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const args=value as Record<string,unknown>;
  const keys=Object.keys(args).sort();
  if(typeof args.content!=='string'||args.content.trim().length===0||
     args.content.length>MAX_NOTE_CONTENT_LENGTH)return false;
  if(tool===REVIEWED_WRITE_TOOL)return keys.length===1&&keys[0]==='content';
  if(tool===REVIEWED_APPEND_TOOL)return keys.length===2&&
    keys[0]==='content'&&keys[1]==='note_id'&&
    typeof args.note_id==='string'&&NOTE_ID.test(args.note_id);
  return false;
}

export function reviewedWriteTool(tool:{
  name?:unknown;
  inputSchema?:unknown;
  annotations?:{readOnlyHint?:boolean;destructiveHint?:boolean};
}):boolean{
  if(typeof tool.name!=='string'||
     !REVIEWED_WRITE_TOOLS.some(name=>name===tool.name)||
     tool.annotations?.readOnlyHint!==false||
     tool.annotations?.destructiveHint!==false)return false;
  const schema=tool.inputSchema as {
    type?:unknown;
    properties?:Record<string,{type?:unknown;minLength?:unknown}>;
    required?:unknown;
  }|undefined;
  if(schema?.type!=='object'||!schema.properties||
     typeof schema.properties!=='object'||Array.isArray(schema.properties)||
     !Array.isArray(schema.required))return false;
  const actual=Object.keys(schema.properties).sort();
  const required=[...schema.required].sort();
  if(schema.properties.content?.type!=='string'||
     schema.properties.content?.minLength!==1)return false;
  if(tool.name===REVIEWED_WRITE_TOOL){
    if(required.length!==1||required[0]!=='content'||
       actual.some(k=>!['content','folder_id','folder_name'].includes(k)))
      return false;
    return ['folder_id','folder_name'].every(k=>
      schema.properties?.[k]===undefined||schema.properties[k]?.type==='string');
  }
  return required.length===2&&required[0]==='content'&&required[1]==='note_id'&&
    actual.length===2&&actual[0]==='content'&&actual[1]==='note_id'&&
    schema.properties.note_id?.type==='string';
}
