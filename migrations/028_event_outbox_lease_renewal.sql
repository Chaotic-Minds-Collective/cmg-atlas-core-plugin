INSERT INTO core.permissions (permission_key, description)
VALUES ('events.renew', 'Renew an active normalized game event lease for assigned servers')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core.roles r
  CROSS JOIN core.permissions p
 WHERE r.role_key IN ('game_event_consumer', 'atlas_quest_runtime')
   AND p.permission_key = 'events.renew'
ON CONFLICT DO NOTHING;
