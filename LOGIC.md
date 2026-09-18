# THROWAWAY prototype: Email Worker runtime probe

This scratch branch answers one load-bearing question:

> Can the current Cloudflare Workers runtime use ImapFlow for IMAP TLS and Nodemailer for SMTP TLS in a real deployed Worker?

Do not merge this prototype into `main`.

## IMAP pass criteria

The deployed Worker must:

1. connect over TLS;
2. authenticate;
3. issue LIST;
4. open INBOX read-only;
5. FETCH one envelope when INBOX is non-empty;
6. logout.

The probe returns counts and booleans only. It does not return message subjects, senders, bodies, or attachments.

## SMTP pass criteria

The deployed Worker must:

1. connect over TLS;
2. authenticate;
3. verify the SMTP transport;
4. send one fixed message to the configured test recipient;
5. close the transport.

The HTTP caller cannot choose a recipient, subject, or body.

## Decision

- IMAP + SMTP pass: use ImapFlow + Nodemailer in the v0.1 spec.
- SMTP passes but IMAP fails due to Worker runtime incompatibility: evaluate a thin `cloudflare:sockets` IMAP adapter before any production implementation.
- Neither result should cause this prototype code to be merged into production.
