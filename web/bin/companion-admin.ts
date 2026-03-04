#!/usr/bin/env bun
/**
 * companion-admin — admin CLI for The Companion
 *
 * Commands:
 *   create-invite [--port <n>]   Generate a one-time passkey registration link
 *   list-keys                    List registered passkeys
 *   revoke-key <id>              Revoke a registered passkey by ID
 *   revoke-sessions              Revoke all active sessions
 *
 * Usage:
 *   bun web/bin/companion-admin.ts create-invite
 *   bun web/bin/companion-admin.ts create-invite --port 3456
 */

import { createInvite, listCredentials, revokeCredential, revokeAllSessions } from "../server/passkey-manager.js";

const args = process.argv.slice(2);
const command = args[0];

function getPort(): number {
  const portFlag = args.indexOf("--port");
  if (portFlag !== -1 && args[portFlag + 1]) {
    return Number(args[portFlag + 1]);
  }
  return Number(process.env.PORT) || 3456;
}

switch (command) {
  case "create-invite": {
    const token = createInvite();
    const port = getPort();
    const url = `http://localhost:${port}/register?invite=${token}`;
    console.log("");
    console.log("  Passkey registration link (one-time use, expires in 24h):");
    console.log("");
    console.log(`  ${url}`);
    console.log("");
    console.log("  Open this URL in the browser where you want to register Face ID / Touch ID.");
    console.log("  The link is consumed on successful registration and cannot be reused.");
    console.log("");
    break;
  }

  case "list-keys": {
    const credentials = listCredentials();
    if (credentials.length === 0) {
      console.log("No passkeys registered.");
    } else {
      console.log(`${credentials.length} registered passkey(s):\n`);
      for (const c of credentials) {
        const date = new Date(c.createdAt).toISOString();
        console.log(`  ID:      ${c.id}`);
        console.log(`  Device:  ${c.deviceName ?? "(unnamed)"}`);
        console.log(`  Created: ${date}`);
        console.log("");
      }
    }
    break;
  }

  case "revoke-key": {
    const id = args[1];
    if (!id) {
      console.error("Usage: companion-admin revoke-key <credential-id>");
      process.exit(1);
    }
    const ok = revokeCredential(id);
    if (ok) {
      console.log(`Revoked passkey: ${id}`);
    } else {
      console.error(`Passkey not found: ${id}`);
      process.exit(1);
    }
    break;
  }

  case "revoke-sessions": {
    revokeAllSessions();
    console.log("All sessions revoked. Users will need to re-authenticate.");
    break;
  }

  default: {
    console.log(`
companion-admin — admin CLI for The Companion

Commands:
  create-invite [--port <n>]   Generate a one-time passkey registration URL (24h TTL)
  list-keys                    List all registered passkeys
  revoke-key <id>              Revoke a specific passkey by ID
  revoke-sessions              Revoke all active login sessions

Examples:
  bun web/bin/companion-admin.ts create-invite
  bun web/bin/companion-admin.ts create-invite --port 3456
  bun web/bin/companion-admin.ts list-keys
  bun web/bin/companion-admin.ts revoke-sessions
`);
    if (command) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  }
}
