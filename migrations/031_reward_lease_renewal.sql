-- Allow the scoped reward worker to extend only its own active claim.
INSERT INTO core.permissions (permission_key, description)
VALUES ('rewards.renew', 'Renew an active game reward lease for assigned servers')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core.roles r
  CROSS JOIN core.permissions p
 WHERE r.role_key = 'reward_worker'
   AND p.permission_key = 'rewards.renew'
ON CONFLICT DO NOTHING;
