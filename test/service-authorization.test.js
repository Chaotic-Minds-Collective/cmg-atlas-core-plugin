import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashServiceToken } from "../dist/auth/service.js";
import { registerPluginRoutes } from "../dist/routes/plugins.js";

test("platform-scoped service assignment still authorizes platform plugin registration", {
  skip: !pool ? "DATABASE_URL is not configured" : false,
}, async () => {
  const app = Fastify();
  await registerPluginRoutes(app);
  const principalId = randomUUID();
  const token = "cg_srv_" + randomBytes(36).toString("base64url");
  const pluginId = "com.chaoticgaming.platform.scope-test-" + randomUUID().replaceAll("-", "");
  try {
    await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'service', 'active')", [principalId]);
    await pool.query("INSERT INTO core.service_accounts (principal_id, application_name) VALUES ($1, $2)", [principalId, "platform-scope-test-" + principalId]);
    await pool.query("INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'platform-scope-test')", [principalId, hashServiceToken(token)]);
    await pool.query("INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'platform', NULL FROM core.roles WHERE role_key = 'plugin_manager'", [principalId]);

    const response = await app.inject({
      method: "POST",
      url: "/plugins",
      headers: { authorization: "Bearer " + token },
      payload: {
        manifest: {
          id: pluginId,
          name: "Platform Scope Authorization Test",
          version: "0.1.0",
          game: "platform",
          apiVersion: "1",
          dependencies: [],
          capabilities: ["server.health.read"],
          permissions: ["server.status.read"],
          compatibility: { gameBuilds: [], serverApi: [], operatingSystems: [] },
          configSchema: {}
        }
      }
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().data.id, pluginId);
  } finally {
    await pool.query("DELETE FROM core.plugin_dependencies WHERE plugin_version_id IN (SELECT id FROM core.plugin_versions WHERE plugin_id = $1)", [pluginId]);
    await pool.query("DELETE FROM core.plugin_installations WHERE plugin_id = $1", [pluginId]);
    await pool.query("DELETE FROM core.plugin_versions WHERE plugin_id = $1", [pluginId]);
    await pool.query("DELETE FROM core.plugins WHERE plugin_id = $1", [pluginId]);
    await pool.query("DELETE FROM core.service_credentials WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.service_accounts WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principals WHERE id = $1", [principalId]);
    await app.close();
    await pool.end();
  }
});
