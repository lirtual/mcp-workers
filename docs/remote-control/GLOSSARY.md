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

**Owner-Stopped Agent**:
An Agent that its owner has deliberately stopped, unlike a service crash, sleep, or network outage.
_Avoid_: Offline device, revoked identity
