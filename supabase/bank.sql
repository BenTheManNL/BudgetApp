-- Duppie: bankkoppeling. Draai dit in de SQL Editor van Supabase.

-- Een vinkje per account: mag dit account de bankkoppeling gebruiken?
alter table public.profielen add column if not exists bank boolean not null default false;

-- Hier bewaart de server de toestemming van de bank. Geen regels (policies) = alleen de server kan erbij.
create table if not exists public.bank_sessies (
  user_id uuid primary key references auth.users on delete cascade,
  state text unique,
  session_id text,
  rekeningen jsonb,
  geldig_tot timestamptz,
  bijgewerkt timestamptz not null default now()
);
alter table public.bank_sessies enable row level security;

-- Zet de bankkoppeling aan voor jouw account
update public.profielen set bank = true
where user_id = (select id from auth.users where email = 'JOUW-EMAIL@voorbeeld.nl');  -- vervang door het e-mailadres van je Duppie-account

-- Controle
select u.email, p.premium, p.bank from public.profielen p join auth.users u on u.id = p.user_id;
