# Remote Control MCP — Device grant language

Terms for the agreed permanent-device idle-grant design. Deployed RCA
behavior remains described by [CONTEXT.md](./CONTEXT.md) until delivery.

## Language

**Permanent Device Grant**:
The owner's continuing server-side authorization for one paired RCA device, separate from the running Agent process.
_Avoid_: Permanent online socket

**Trusted Device Online**:
An Agent connection evidenced by a recently verified, authenticated signed WSS session for the currently approved identity.
_Avoid_: Open TCP socket, last-connected timestamp

**Idle Grant Deadline**:
A server-owned absolute expiration time for a still-paired permanent device no longer held in a valid online state.
_Avoid_: Local sleep timer, operation receipt expiry

**Online Reset**:
The restoration of no-countdown online hold on valid authenticated reconnection before expiry, so the next actual disconnection starts a fresh full idle interval.
_Avoid_: Heartbeat extension while OFF, automatic re-pairing

**Owner-Stopped Agent**:
An Agent intentionally stopped by the OS owner, distinct from a crash, host sleep or network outage.
_Avoid_: Offline Agent, revoked device

**Pending Owner Stop**:
A locally persistent intentional Stop whose cloud-side acknowledgement has not yet been confirmed.
_Avoid_: Confirmed server Stop, automatic disconnection

**Owner Resume**:
An explicit OS-owner-initiated restoration of an existing still-valid grant after pending Stop reconciliation and device-signed authorization.
_Avoid_: Automatic reconnect, new pairing
