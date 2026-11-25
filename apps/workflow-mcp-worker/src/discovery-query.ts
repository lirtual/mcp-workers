// SQLite's built-in lower() folds ASCII only. Keep the same literal
// matching semantics for the in-memory reviewed catalogs.
export function asciiLower(value:string):string{
 return value.replace(/[A-Z]/g,c=>c.toLowerCase());
}

export function matchingCandidates<T>(items:T[],query:string|undefined,
 identity:(item:T)=>string,name:(item:T)=>string,extra:(item:T)=>unknown[]=()=>[]):T[]{
 if(query===undefined)return items;
 const needle=asciiLower(query);
 return items.flatMap(item=>{
  const id=asciiLower(identity(item)),label=asciiLower(name(item));
  const rank=id===needle?0:label===needle?1:
    [id,label,...extra(item).filter((v):v is string=>typeof v==='string').map(asciiLower)]
      .some(value=>value.includes(needle))?2:-1;
  return rank<0?[]:[{item,rank,id:identity(item)}];
 }).sort((a,b)=>a.rank-b.rank||(a.id<b.id?-1:a.id>b.id?1:0)).map(x=>x.item);
}
