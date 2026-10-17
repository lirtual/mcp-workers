# EdgeSSH MCP — Domain Context

**Status:** Operator decisions Q1–Q22 settled on 2026-10-17, with **Q3=A and Q14=A expressly superseded by Q22=B**. Final architecture reviewed, **not yet approved for `to-spec` or implementation**. EdgeSSH fork/production must remain unchanged.

This is a domain dictionary: technology, database layout, encryption algorithm and release mechanics belong in the [decision records](./adr/0005-independent-mcp-ssh-shared-edgessh-credentials.md) and [final review](./FINAL-ARCHITECTURE-REVIEW.md).

## Domain vocabulary

**EdgeSSH Workspace**:
The independently operated single-administrator SSH workspace that owns saved host records and is usable without the MCP companion.

**Saved Host**:
A record of a remote SSH endpoint and its access configuration within the EdgeSSH Workspace. A Saved Host is not necessarily reachable, trusted or online.

**Shared Host Catalog**:
The set of Saved Host records maintained by EdgeSSH and consulted by its MCP companion. It remains the source of truth for host entries and changes; no second independently edited host catalog is implied.

**SSH Credential**:
A password or private key authorizing login to the remote account. An SSH Credential is distinct from the identity of the remote SSH server or authorization of an AI client.

**Credential Custodian**:
A component authorized to access, decrypt and use SSH Credentials. Under Q22=B, **EdgeSSH and the MCP companion are both custodians**; the MCP caller must not receive decrypted credentials.

**SSH Host Identity**:
The identity of the remote SSH server verified against its already human-confirmed public host-key fingerprint. A valid SSH password is not proof of the intended server's identity.

**MCP-Eligible Host**:
Any Saved Host in the EdgeSSH Workspace, with no per-host MCP opt-in. Eligibility does not override missing credentials, required host-key trust or the remote login's privileges.

**MCP Caller**:
An AI client authorized to request tools in the EdgeSSH MCP companion. Caller authorization does not substitute for SSH Credentials or SSH Host Identity verification.

**MCP Tool Call**:
A named, bounded operation requested by an MCP Caller, with a defined target, parameters and outcome.

**Remote Command**:
A caller-specified SSH command, including interactive input capable of changing remote files, processes or services. It is not read-only merely because it appears diagnostic.

**Remote File Operation**:
An operation to list, read, create, edit, rename or remove remote files/directories. Destructive and text-writing requests have explicit intent and can have uncertain or partial effects.

**Text File Mutation**:
An explicitly authorized, bounded change to remote text, distinct from binary transfer or an assertion of atomic replacement.

**SSH Session**:
A live authenticated SSH connection with a separate establishment, activity and end lifecycle.

**Managed SSH Session**:
A caller-addressable interactive SSH session that can outlive the original tool call. A recorded session identifier is not proof its TCP/SSH connection remains alive.

**Session-Owned Job**:
A remote task controllable through a specific, currently live SSH session/channel with provable ownership. A detached or PID-only process is not presumed owned after disconnect.

**Interactive Input**:
A bounded unit of data sent to a Managed SSH Session. Input can cause remote side effects even if no separate `exec` call occurs.

**Lost Session**:
A session whose remote connection or controllable channel can no longer be proven live. Prior identity/status may still be observable; its old commands or process must not be automatically resurrected.

**Operation ID**:
A stable identifier for one intended effectful operation. The same ID cannot silently describe a new or different action.

**Operation Admission**:
The durable acceptance of an Operation ID and its intent before attempting the external side effect. Admission does not prove execution.

**Operation Receipt**:
A durable record of known admission and outcome information, used to recognize duplicate submissions, distinguish failures and preserve uncertainty. It does **not** guarantee exactly-once remote effects.

**Operation Conflict**:
A request with an existing Operation ID but mismatching target/operation/arguments. A conflict must not dispatch the new request.

**Unknown Outcome**:
A state where a remote effect may have occurred but cannot be established. Timeout, lost connection or failed acknowledgement is not proof that nothing happened.

**Reconciliation**:
Deliberate investigation of an Unknown Outcome before initiating any new action. Merely reading or acknowledging a receipt is not permission to blindly replay it.

**Session Stop**:
A request to end a provably owned live session or job. Closing a connection or signalling a session is not a guarantee that detached remote descendants stopped.

**Unattended Operation**:
A permitted command or file modification that may proceed without a new human confirmation on each invocation, under the SSH account's actual privileges.

**Revoked Caller Credential**:
An expired or rotated MCP access credential invalid for subsequent requests. Revocation does not retroactively undo remotely running effects.

**Unmodified Upstream Application**:
The independently maintained EdgeSSH fork whose code, deployment configuration, credential store and runtime contract are not changed by the MCP companion.

## Settled product invariants

1. EdgeSSH remains a separately maintained application, fully usable with the MCP companion absent (**Q21**).
2. **All** Saved Hosts are eligible, without per-host approval (**Q4=B**). Untrusted or unreachable hosts must fail connection rather than bypass checks.
3. MCP supports SSH commands, interactive managed sessions, live session-owned background work, and bounded text-only SFTP mutations (**Q2=B, Q6=B, Q10=A**).
4. A human must have confirmed the remote SSH Host Identity. Unknown or changed fingerprint never obtains automatic model approval (**Q7=A**).
5. A dedicated MCP caller credential permits unattended operation across eligible hosts; no separate approval per call (**Q5=A, Q8=A**).
6. **Q22=B supersedes Q3=A:** EdgeSSH remains authoritative for the Shared Host Catalog, but the MCP companion may itself use credentials already stored there. The MCP Caller never receives those credentials.
7. **Q22=B supersedes Q14=A:** the MCP companion's own SSH execution boundary is authoritative for Operation Admission and receipts; EdgeSSH does not have to implement an MCP execution/receipt API.
8. Managed sessions have fixed capacity, bounded output and finite lifetimes. Loss is reported honestly: no automatic old-command replay, terminal restoration, or detached PID takeover (**Q11=A, Q12=A, Q15=A**).
9. Every effectful operation, including Interactive Input, uses an Operation ID and durable receipt/deduplication. A mismatch conflicts; stored records cannot prove exactly-once remote effects (**Q9=B, Q13=A**).
10. Text File Mutations have bounded size and explicit overwrite/delete intent; they do not imply binary transfer or universal atomicity (**Q16=A**).
11. Known terminal receipts have a normal 30-day life; unresolved minimal markers remain until deliberate reconciliation. No automatic retry or compensation of Unknown Outcomes (**Q17=A, Q18=A**).
12. Failed durable admission blocks new effects; an authenticated stop of a *proven live owned* session may be attempted as a narrow emergency exception. Revoked credentials deny new requests but cannot guarantee termination of all running remote effects (**Q19=A, Q20=A**).

## Semantic guardrails

- Do not call a logically read-only host-catalog consumer a database-permission-enforced read-only principal unless the infrastructure actually provides it.
- Do not conflate SSH Credential custody, SSH Host Identity, MCP bearer authorization and cloud resource access.
- Do not expose the **saved connection credentials or shared encryption root** as MCP tool fields, receipts or logs. An arbitrary SSH command or remote text-file read can itself return confidential remote data; do not claim it is automatically redacted.
- Do not infer liveness from persisted session identity or guarantee termination of detached processes.
- Do not relabel `unknown` as safely failed or re-run a stored operation ID.
- Do not claim EdgeSSH itself executes MCP commands or stores MCP receipts after Q22=B.
- Historical Q3=A/Q14=A decisions are superseded **only in execution/receipt responsibility**, not a silent reversal of the rest of the agreed feature scope.
