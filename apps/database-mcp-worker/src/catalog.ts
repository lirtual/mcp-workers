import references from '../connection-references.json' with {type:'json'};
import manifest from '../hyperdrive-bindings.json' with {type:'json'};
import {parseDirectDatabaseUrl} from './config.ts';
import {PublicError} from './errors.ts';
import type {Dialect, Env} from './types.js';

function invalid(): never {
  throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Database connection configuration is invalid or unavailable.');
}
export interface CatalogEntry {id:string; dialect:Dialect; transport:'direct'|'hyperdrive'; url?:string; bindingName?:string}

/** Flat JSON grammar also detects duplicate (including escaped) logical IDs. */
export function connectionInventory(raw: unknown): Record<string,string> {
  if (typeof raw !== 'string' || raw.length > 90_000) invalid();
  const source = raw.trim();
  if (!source.startsWith('{') || !source.endsWith('}')) invalid();
  const body = source.slice(1,-1);
  // JSON excludes raw control characters; escaped characters are decoded before validation.
  // eslint-disable-next-line no-control-regex
  const pair = /\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*/y;
  const result:Record<string,string> = Object.create(null);
  let offset=0;
  while (body.slice(offset).trim()) {
    pair.lastIndex=offset;
    const match=pair.exec(body);
    if (!match) invalid();
    const id: string=JSON.parse(match[1]!);
    const value: string=JSON.parse(match[2]!);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || Object.hasOwn(result,id) ||
        !value || value.length>8192 || Object.keys(result).length>=10) invalid();
    result[id]=value;
    offset=pair.lastIndex;
    if (offset===body.length) break;
    if (body[offset]!==',' || !body.slice(offset+1).trim()) invalid();
    offset++;
  }
  return result;
}

/** Resolve tokens once within their allowed URI component, never as URI syntax. */
function directUrl(template:string, env:Env):string {
  const parts=/^(mysql|postgresql):\/\/([^:@/?#]+):([^@/?]+)@([^/?]+)(\/[^?]*)?$/.exec(template);
  if (!parts) invalid();
  const password=parts[3]!;
  const secret=/^\$\{([A-Z][A-Z0-9_]{0,63})\}$/.exec(password);
  if (!secret || !references.secrets.includes(secret[1]!)) invalid();
  const secretValue=env[secret[1]!];
  // eslint-disable-next-line no-control-regex
  if (typeof secretValue!=='string' || !secretValue || secretValue.length>4096 || /[\u0000-\u001f\u007f]|\$\{|#\{/.test(secretValue)) invalid();
  const component=(value:string, field:'user'|'host'|'port'|'database')=>{
    const resolved=value.replace(/#\{([A-Z][A-Z0-9_]{0,63})\}/g,(_token,name:string)=>{
      if (!references.variables.includes(name)) invalid();
      const replacement=env[name];
      if (typeof replacement!=='string' || !replacement || replacement.length>2048 ||
          // eslint-disable-next-line no-control-regex
          /[\u0000-\u0020\u007f]|\$\{|#\{/.test(replacement)) invalid();
      return field==='host'||field==='port' ? replacement : encodeURIComponent(replacement);
    });
    if (/[${}#]/.test(resolved)) invalid();
    if (field==='host' && !/^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(resolved)) invalid();
    if (field==='port' && !/^\d{1,5}$/.test(resolved)) invalid();
    return resolved;
  };
  const authority=/^(\[[^\]]+\]|[^:]+)(?::([^:]+))?$/.exec(parts[4]!);
  if (!authority) invalid();
  const host=component(authority[1]!,'host');
  const port=authority[2]===undefined?'':':'+component(authority[2],'port');
  const path=parts[5]??'';
  if (path.includes('#') && !/#\{/.test(path)) invalid();
  const database=component(path.slice(1),'database');
  if (database.includes('/')) invalid();
  return `${parts[1]}://${component(parts[2]!,'user')}:${encodeURIComponent(secretValue)}@${host}${port}/${database}`;
}

export function configuredCatalog(env:Env):CatalogEntry[] {
  try {
    return Object.entries(connectionInventory(env.DATABASE_CONNECTIONS)).map(([id,reference])=>{
      if ([...reference].some(char=>char.charCodeAt(0)<=32 || char.charCodeAt(0)===127)) invalid();
      if (reference.startsWith('hyperdrive://')) {
        const bindingName=reference.slice('hyperdrive://'.length);
        if (!/^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(bindingName)) invalid();
        const declared=(manifest as Array<{binding:string;id:string;dialect:Dialect}>).filter(row=>row.binding===bindingName);
        if (declared.length!==1 || !['mysql','postgres'].includes(declared[0]!.dialect)) invalid();
        return {id,transport:'hyperdrive',dialect:declared[0]!.dialect,bindingName};
      }
      const url=directUrl(reference,env);
      return {id,transport:'direct',dialect:parseDirectDatabaseUrl(url,id).dialect,url};
    });
  } catch {return invalid();}
}
