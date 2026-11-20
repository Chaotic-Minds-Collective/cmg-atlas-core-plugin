-- Server-scoped permission for extending an active ATLAS color-token application lease.
-- Existing claim and acknowledgement permissions remain unchanged.
INSERT INTO core.permissions (permission_key, description)
VALUES ('atlas.color_tokens.renew', 'Renew an active ATLAS color-token application lease for an assigned server')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core.roles r
  CROSS JOIN core.permissions p
 WHERE r.role_key = 'atlas_color_token_worker'
   AND p.permission_key = 'atlas.color_tokens.renew'
ON CONFLICT DO NOTHING;
