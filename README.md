# email-mcp-worker runtime prototype

**THROWAWAY:** runtime compatibility experiment only. See [LOGIC.md](./LOGIC.md).

## Configure

The Worker requires two runtime secrets:

- `PROTOTYPE_ACCESS_TOKEN`
- `EMAIL_PROBE_CONFIG`

Example QQ Mail probe config:

```json
{
  "imap": {
    "host": "imap.qq.com",
    "port": 993,
    "secure": true,
    "user": "you@qq.com",
    "password": "<authorization-code>"
  },
  "smtp": {
    "host": "smtp.qq.com",
    "port": 465,
    "secure": true,
    "user": "you@qq.com",
    "password": "<authorization-code>",
    "from": "you@qq.com"
  },
  "test_recipient": "you@qq.com"
}
```

Keep the real JSON only in Cloudflare Runtime Secrets.

## Check and deploy

Run from this directory:

```bash
pnpm install
pnpm run check
pnpm exec wrangler secret put PROTOTYPE_ACCESS_TOKEN
pnpm exec wrangler secret put EMAIL_PROBE_CONFIG
pnpm run deploy
```

## IMAP probe

```bash
curl -sS -X POST "https://email-mcp-worker-prototype.<workers-subdomain>.workers.dev/probe/imap" \
  -H "Authorization: Bearer <PROTOTYPE_ACCESS_TOKEN>"
```

A passing response has `ok: true`, a folder count, an INBOX message count, and confirms whether one envelope was fetched.

## SMTP probe

**This sends one real, fixed test email to `test_recipient`.**

```bash
curl -sS -X POST "https://email-mcp-worker-prototype.<workers-subdomain>.workers.dev/probe/smtp" \
  -H "Authorization: Bearer <PROTOTYPE_ACCESS_TOKEN>"
```

The caller cannot override the recipient, subject, or body.
