# Remote Control MCP — Device grant language

Vocabulary for the pending idle-grant design. Deployed current behavior
remains described by [CONTEXT.md](./CONTEXT.md).

## Language

**Permanent Device Grant**:
The owner's continuing server-side authorization for a paired RCA device, distinct from its running Agent process.
_Avoid_: Permanent online socket

**Trusted Device Online**:
A device status backed by recent authenticated signed WSS session evidence for its current approved identity.
_Avoid_: TCP connected, last-connected time

**Idle Grant Deadline**:
A server-owned time limit on the continuing authorization of a permanent device that is not in its valid online-hold state.
_Avoid_: Local process timeout, receipt expiry

**Online Reset**:
The restoration of full unused idle allowance by an already approved, owner-ON device becoming freshly and authentically online before its existing deadline; a subsequent offline period begins a new deadline.
_Avoid_: Heartbeat extension while OFF, automatic re-pair

**Owner-Stopped Agent**:
An Agent that its owner has deliberately stopped, unlike a service crash, sleep, or network outage.
_Avoid_: Offline device, revoked identity


**Pending Owner Stop**:
A locally persisted intentional Stop that has not yet been reliably acknowledged by the server.
_Avoid_: Confirmed cloud revocation, ordinary disconnection

**Owner Resume**:
A deliberate local action that re-enables an existing still-valid permanent grant after the server authenticates the device and accepts the pending Stop state.
_Avoid_: Automatic reconnect, fresh pairing
