import { discoverRaindropLiveContract } from './raindrop-discovery.js';

const token = process.env.WORKFLOW_MCP_ACCESS_TOKEN;
if (!token) throw new Error('WORKFLOW_MCP_ACCESS_TOKEN is required for Raindrop discovery.');
const evidence = await discoverRaindropLiveContract(token);
console.log(JSON.stringify(evidence, null, 2));
