alter table integration_settings add column if not exists oauth_access_token text not null default '';
