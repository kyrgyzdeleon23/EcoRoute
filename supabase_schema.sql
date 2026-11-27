-- Run this script in Supabase Dashboard > SQL Editor before starting the app.

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    name text not null,
    role text not null default 'user' check (role in ('user', 'admin')),
    phone text not null default '',
    created_at timestamptz not null default now()
);

alter table public.profiles
    add column if not exists phone text not null default '';

create table if not exists public.requests (
    id text primary key,
    owner_id uuid not null references auth.users(id) on delete cascade,
    data jsonb not null,
    created_at timestamptz not null default now()
);

create index if not exists requests_owner_id_idx on public.requests(owner_id);
create index if not exists requests_created_at_idx on public.requests(created_at desc);

create table if not exists public.audit_log (
    id bigint generated always as identity primary key,
    data jsonb not null,
    created_at timestamptz not null default now()
);

create table if not exists public.hubs (
    name text primary key,
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180)
);

create table if not exists public.hub_edges (
    hub_a text not null references public.hubs(name) on delete cascade,
    hub_b text not null references public.hubs(name) on delete cascade,
    distance double precision not null check (distance >= 0),
    primary key (hub_a, hub_b),
    check (hub_a < hub_b)
);

create table if not exists public.app_settings (
    key text primary key,
    data jsonb not null
);

alter table public.profiles enable row level security;
alter table public.requests enable row level security;
alter table public.audit_log enable row level security;
alter table public.hubs enable row level security;
alter table public.hub_edges enable row level security;
alter table public.app_settings enable row level security;

insert into public.hubs (name, latitude, longitude) values
    ('Batangas City', 13.7565, 121.0583),
    ('Bulacan Baliwag', 14.9547, 120.9003),
    ('Cabuyao Laguna', 14.2726, 121.1262),
    ('Lucban Quezon', 14.1136, 121.5550),
    ('Bauan Batangas', 13.7917, 121.0085)
on conflict (name) do nothing;

insert into public.app_settings (key, data) values
    ('pickup_route', '{"sort_by":"nearest","starting_hub":"Batangas City"}'::jsonb)
on conflict (key) do nothing;

insert into public.hub_edges (hub_a, hub_b, distance) values
    ('Batangas City', 'Bauan Batangas', 10.0),
    ('Batangas City', 'Cabuyao Laguna', 63.0),
    ('Cabuyao Laguna', 'Lucban Quezon', 61.0),
    ('Bulacan Baliwag', 'Cabuyao Laguna', 100.0),
    ('Bulacan Baliwag', 'Lucban Quezon', 130.0)
on conflict (hub_a, hub_b) do nothing;

-- After creating your account in the app, promote it to administrator:
-- update public.profiles
-- set role = 'admin'
-- where id = (select id from auth.users where email = 'your-admin-email@example.com');
