// THROWAWAY prototype for #173. Never merge or deploy as a production service.
export class RelayState {
  constructor() {
    this.socket = null;
    this.generation = null;
    this.revoked = false;
    this.pending = new Map();
  }

  restore(socket, generation) {
    // Socket attachments survive DO hibernation; in-flight HTTP calls do not.
    this.socket = socket;
    this.generation = generation;
  }

  connect(socket, generation) {
    if (this.revoked) return false;
    this.failAll("reconnected");
    if (this.socket && this.socket !== socket) {
      try { this.socket.close(4001, "superseded"); } catch {}
    }
    this.socket = socket;
    this.generation = generation;
    return true;
  }

  invoke(id, tool, args, timeoutMs = 1500) {
    if (this.revoked) return Promise.reject(new Error("revoked"));
    if (!this.socket) return Promise.reject(new Error("offline"));
    if (this.pending.has(id)) return Promise.reject(new Error("duplicate_call_id"));
    let finish;
    const promise = new Promise((resolve, reject) => { finish = { resolve, reject }; });
    const timer = setTimeout(() => {
      const item = this.pending.get(id);
      if (!item) return;
      this.pending.delete(id);
      item.reject(new Error("timeout"));
    }, timeoutMs);
    const generation = this.generation;
    this.pending.set(id, { ...finish, timer, generation });
    try {
      this.socket.send(JSON.stringify({ type: "call", id, tool, arguments: args }));
    } catch {
      this.failOne(id, "offline");
    }
    return promise;
  }

  failOne(id, reason) {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    clearTimeout(item.timer);
    item.reject(new Error(reason));
    return true;
  }

  result(socket, message) {
    if (this.revoked || socket !== this.socket) return false;
    const item = this.pending.get(message.id);
    if (!item || item.generation !== this.generation) return false;
    this.pending.delete(message.id);
    clearTimeout(item.timer);
    item.resolve(message.result);
    return true;
  }

  failAll(reason) {
    for (const id of [...this.pending.keys()]) this.failOne(id, reason);
  }

  disconnect(socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.generation = null;
    this.failAll("offline");
  }

  revoke() {
    this.revoked = true;
    this.failAll("revoked");
    const old = this.socket;
    this.socket = null;
    this.generation = null;
    try { old?.close(4003, "revoked"); } catch {}
  }
}
