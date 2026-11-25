insert into oauth_clients (client_id, name, secret, grant_type, scopes)
select 'managetech', 'managetech', secret, 'authorization_code', coalesce(nullif(scopes, ''), 'read write')
from oauth_clients
where client_id = 'mts-portal'
on conflict (client_id) do update set
  name = 'managetech',
  grant_type = 'authorization_code',
  scopes = excluded.scopes,
  secret = case when oauth_clients.secret = '' then excluded.secret else oauth_clients.secret end;

insert into oauth_clients (client_id, name, secret, grant_type, scopes)
values (
  'managetech',
  'managetech',
  '7f3c1a9e4b28d6c04a51e8f27b90c3d6a14e5f82c7b09d31e6a4c8f25b17d903',
  'authorization_code',
  'read write'
)
on conflict (client_id) do update set
  name = 'managetech',
  grant_type = 'authorization_code';
