# Changelog

## 0.5.0

- Add Cloudflare Workers-native deployment.
- Use Cloudflare Agents stateless MCP SDK v2 handler.
- Replace local SQLite with Cloudflare D1.
- Move server secrets to Workers Secrets.
- Keep per-user IMA credentials encrypted with AES-GCM in D1.
- Preserve OAuth + PKCE, refresh rotation, revoke and disconnect.
- Add Wrangler config, D1 migrations and deployment guide.
