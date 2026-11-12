# ADR-0015: Owner-reviewed device pairing

A locally generated Ed25519 device identity is approved through one short-lived pairing request and an authenticated Owner action. Approval is for a specific identity and explicitly selected permanent or temporary grant, never for a display name alone. Reconnection must prove possession of the same identity; it does not silently recreate, extend or upgrade a revoked grant.

Temporary device grants have bounded, nonrenewable lifetimes. Device identity, grant expiration, temporary Session authority and Agent-side process ownership are separate checks. Revocation and unknown outcomes fail closed and do not erase historical receipts.

The current protocol and acceptance contract are in Worker/Agent source and tests. Historical rollout evidence remains in Git and the relevant issues; this ADR does not authorize pairing, production changes or credentials.
