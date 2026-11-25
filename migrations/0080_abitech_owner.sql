update integration_settings
set email = 'admin@abitech.site',
    subdomain = 'managetechservices-16737'
where id = 1;

update portal_staff
set role = 'owner', active = true
where lower(email) = 'admin@abitech.site';
