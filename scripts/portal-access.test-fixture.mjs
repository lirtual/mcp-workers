// Independent fixture from the reviewed live Access configuration (2026-11-25).
export function accessPolicies(serviceFirst=false) {
  const service={id:'b3dcac1d-c37e-40f0-b201-1d5f08f81577',
    name:'MCP Gateway Service Auth',decision:'non_identity',reusable:true,
    include:['93f24170-6bf8-4a06-bf97-fb11bd9268bf','8624dd66-918c-41bf-9637-676da2503524']
      .map(token_id=>({service_token:{token_id}})),exclude:[],require:[]};
  const owner={id:'659d043c-e957-4c91-9f33-2416c52ecbe5',
    name:'Default Allow Rule',decision:'allow',reusable:true,
    include:['lirtual@qq.com','lirtual@outlook.com','lirtual@gmail.com']
      .map(email=>({email:{email}})),exclude:[],require:[]};
  return (serviceFirst?[service,owner]:[owner,service])
    .map((policy,i)=>({...policy,precedence:i+1}));
}
export function accessApplications(name='OpenList MCP',withPolicies=true) {
  return [
    {id:'portal',name:'MCP Portal',type:'mcp_portal',
      domain:'mcp-portal.lirtual.dpdns.org',policies:accessPolicies(true)},
    {id:'app',name,type:'mcp',policies:withPolicies?accessPolicies(name==='Browser'):[]},
  ];
}
