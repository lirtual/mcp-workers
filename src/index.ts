import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store" }
});

function loadConfig(raw) {
  if (!raw) throw new Error("EMAIL_PROBE_CONFIG is missing");
  const cfg = JSON.parse(raw);
  if (!cfg || typeof cfg !== "object") throw new Error("EMAIL_PROBE_CONFIG must be an object");
  return cfg;
}

function authorized(request, expected) {
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") && header.slice(7) === expected;
}

async function imapLibraryProbe(cfg) {
  const imap = cfg.imap || {};
  if (!imap.host || !imap.user || !imap.password) {
    throw new Error("imap.host/user/password required");
  }

  const client = new ImapFlow({
    host: imap.host,
    port: Number(imap.port || 993),
    secure: imap.secure !== false,
    auth: {
      user: imap.user,
      pass: imap.password
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });

  let connected = false;

  try {
    await client.connect();
    connected = true;

    const folders = await client.list();
    const inbox = await client.mailboxOpen("INBOX", { readOnly: true });

    let fetchedLatestEnvelope = false;
    if (inbox.exists > 0) {
      const message = await client.fetchOne(inbox.exists, {
        uid: true,
        envelope: true,
        flags: true
      });
      fetchedLatestEnvelope = Boolean(message);
    }

    return {
      ok: true,
      library: "imapflow",
      connected: true,
      folder_count: folders.length,
      inbox_exists: inbox.exists,
      fetched_latest_envelope: fetchedLatestEnvelope
    };
  } finally {
    if (connected) {
      try {
        await client.logout();
      } catch {
        try { client.close(); } catch {}
      }
    }
  }
}

async function smtpLibraryProbe(cfg) {
  const smtp = cfg.smtp || {};
  if (!smtp.host || !smtp.user || !smtp.password) {
    throw new Error("smtp.host/user/password required");
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port || 465),
    secure: smtp.secure !== false,
    auth: {
      user: smtp.user,
      pass: smtp.password
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });

  try {
    const verified = await transporter.verify();
    return {
      ok: true,
      library: "nodemailer",
      verified: Boolean(verified)
    };
  } finally {
    transporter.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        status: "ok",
        prototype: true,
        kind: "library-runtime-probe",
        configured: Boolean(env.EMAIL_PROBE_CONFIG),
        protected: Boolean(env.PROTOTYPE_ACCESS_TOKEN)
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    if (url.pathname !== "/probe/imap-library" && url.pathname !== "/probe/smtp-library") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    if (!authorized(request, env.PROTOTYPE_ACCESS_TOKEN)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "www-authenticate": "Bearer"
        }
      });
    }

    let cfg;
    try {
      cfg = loadConfig(env.EMAIL_PROBE_CONFIG);
    } catch (error) {
      return json({
        ok: false,
        error: "configuration_error",
        message: error instanceof Error ? error.message : String(error)
      }, 503);
    }

    try {
      if (url.pathname === "/probe/imap-library") {
        return json(await imapLibraryProbe(cfg));
      }
      return json(await smtpLibraryProbe(cfg));
    } catch (error) {
      return json({
        ok: false,
        error: "probe_failed",
        probe: url.pathname.endsWith("imap-library") ? "imapflow" : "nodemailer",
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error)
      }, 502);
    }
  }
};
