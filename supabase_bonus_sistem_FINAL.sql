-- ZANVIELLE SATIŞ ORTAĞI BONUS SİSTEMİ
-- 50 müşteri + 1 satış = 500 TL
-- 100 müşteri + 3 satış = 1.500 TL
-- 200 müşteri + 5 satış = 3.500 TL
-- 500 müşteri + 10 satış = 10.000 TL
-- Satışlar Shopier'de gerçekleşir; bu sistem ödeme almaz ve webhook kullanmaz.

create table if not exists public.referral_partners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text not null,
  phone text,
  referral_code text not null unique,
  status text not null default 'pending' check (status in ('pending','approved','suspended')),
  customer_count integer not null default 0 check (customer_count >= 0),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table if not exists public.referral_customers (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.referral_partners(id) on delete cascade,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  unique(partner_id, customer_user_id)
);

create table if not exists public.referral_sales (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.referral_partners(id) on delete cascade,
  customer_user_id uuid not null references auth.users(id) on delete cascade,
  shopier_order_id text not null unique,
  status text not null default 'verified' check (status in ('verified','rejected')),
  verified_at timestamptz not null default now(),
  verified_by uuid references auth.users(id) on delete set null
);

create table if not exists public.referral_bonus_ledger (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.referral_partners(id) on delete cascade,
  tier_customers integer not null check (tier_customers in (50,100,200,500)),
  bonus_amount numeric(12,2) not null check (bonus_amount > 0),
  created_at timestamptz not null default now(),
  unique(partner_id,tier_customers)
);

create index if not exists referral_customers_partner_idx on public.referral_customers(partner_id);
create index if not exists referral_customers_customer_idx on public.referral_customers(customer_user_id);
create index if not exists referral_sales_partner_idx on public.referral_sales(partner_id);

alter table public.referral_partners enable row level security;
alter table public.referral_customers enable row level security;
alter table public.referral_sales enable row level security;
alter table public.referral_bonus_ledger enable row level security;

create or replace function public.znv_is_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.admin_users where id=auth.uid() and active=true and role in ('admin','editor'));
$$;

-- Başvuru sadece giriş yapmış gerçek kullanıcıya bağlanır.
create or replace function public.znv_partner_apply(p_name text,p_email text,p_phone text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Önce müşteri hesabınızla giriş yapmalısınız.'; end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Ad soyad gerekli'; end if;
  if position('@' in trim(coalesce(p_email,''))) < 3 then raise exception 'Geçerli e-posta gerekli'; end if;
  if exists(select 1 from public.referral_partners where user_id=auth.uid()) then raise exception 'Bu hesap için zaten satış ortağı başvurusu mevcut.'; end if;
  insert into public.referral_partners(user_id,name,email,phone,referral_code,status)
  values(auth.uid(),trim(p_name),lower(trim(p_email)),nullif(trim(p_phone),''),'PENDING-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),'pending')
  returning id into v_id;
  return jsonb_build_object('ok',true,'id',v_id);
end $$;
grant execute on function public.znv_partner_apply(text,text,text) to authenticated;

-- Referansla gelen müşteri: yalnızca Auth kullanıcısı sayılır; ortak kendisini sayamaz.
create or replace function public.znv_referral_register_current_customer(p_referral_code text)
returns table(customer_count integer,qualified boolean)
language plpgsql security definer set search_path=public as $$
declare v_partner_id uuid; v_count integer;
begin
  if auth.uid() is null then return query select 0,false; return; end if;
  select id into v_partner_id from public.referral_partners where referral_code=trim(p_referral_code) and status='approved' limit 1;
  if v_partner_id is null then return query select 0,false; return; end if;
  if exists(select 1 from public.referral_partners where id=v_partner_id and user_id=auth.uid()) then return query select 0,false; return; end if;
  insert into public.referral_customers(partner_id,customer_user_id) values(v_partner_id,auth.uid()) on conflict(partner_id,customer_user_id) do nothing;
  select count(*)::integer into v_count from public.referral_customers where partner_id=v_partner_id;
  update public.referral_partners set customer_count=v_count where id=v_partner_id;
  return query select v_count,(v_count>=50);
end $$;
grant execute on function public.znv_referral_register_current_customer(text) to authenticated;

-- Ortak kendi istatistiğini görür; ham müşteri/satış kayıtlarını göremez.
create or replace function public.znv_referral_get_current_partner()
returns table(customer_count integer,verified_sales integer,bonus_balance numeric,referral_code text,status text)
language sql security definer set search_path=public as $$
  select p.customer_count,
    (select count(*)::integer from public.referral_sales s where s.partner_id=p.id and s.status='verified'),
    coalesce((select sum(bonus_amount) from public.referral_bonus_ledger b where b.partner_id=p.id),0),
    p.referral_code,p.status
  from public.referral_partners p where p.user_id=auth.uid() limit 1;
$$;
grant execute on function public.znv_referral_get_current_partner() to authenticated;

-- Kademeleri idempotent olarak bonus bakiyesine işler.
create or replace function public.znv_recalc_referral_bonus(p_partner_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare n integer; s integer;
begin
  select customer_count into n from public.referral_partners where id=p_partner_id;
  select count(*)::integer into s from public.referral_sales where partner_id=p_partner_id and status='verified';
  if n>=50 and s>=1 then insert into public.referral_bonus_ledger(partner_id,tier_customers,bonus_amount) values(p_partner_id,50,500) on conflict do nothing; end if;
  if n>=100 and s>=3 then insert into public.referral_bonus_ledger(partner_id,tier_customers,bonus_amount) values(p_partner_id,100,1000) on conflict do nothing; end if;
  if n>=200 and s>=5 then insert into public.referral_bonus_ledger(partner_id,tier_customers,bonus_amount) values(p_partner_id,200,2000) on conflict do nothing; end if;
  if n>=500 and s>=10 then insert into public.referral_bonus_ledger(partner_id,tier_customers,bonus_amount) values(p_partner_id,500,6500) on conflict do nothing; end if;
end $$;

-- Admin özeti.
create or replace function public.znv_admin_referral_summary()
returns table(id uuid,name text,email text,referral_code text,status text,customer_count integer,verified_sales integer,bonus_balance numeric)
language sql security definer set search_path=public as $$
  select p.id,p.name,p.email,p.referral_code,p.status,p.customer_count,
    (select count(*)::integer from public.referral_sales s where s.partner_id=p.id and s.status='verified'),
    coalesce((select sum(b.bonus_amount) from public.referral_bonus_ledger b where b.partner_id=p.id),0)
  from public.referral_partners p where public.znv_is_admin() order by p.created_at desc;
$$;
grant execute on function public.znv_admin_referral_summary() to authenticated;


-- Admin: belirli bir ortağın referansıyla gelen tüm müşterileri ID, e-posta, tarih ve satış durumu ile listeler.
create or replace function public.znv_admin_referral_customers(p_partner_id uuid)
returns table(customer_user_id uuid,customer_email text,referral_code text,first_seen_at timestamptz,verified_sale boolean,shopier_order_id text)
language sql security definer set search_path=public as $$
  select rc.customer_user_id,
    u.email::text,
    p.referral_code,
    rc.first_seen_at,
    exists(select 1 from public.referral_sales s where s.partner_id=rc.partner_id and s.customer_user_id=rc.customer_user_id and s.status='verified') as verified_sale,
    (select s.shopier_order_id from public.referral_sales s where s.partner_id=rc.partner_id and s.customer_user_id=rc.customer_user_id and s.status='verified' order by s.verified_at desc limit 1) as shopier_order_id
  from public.referral_customers rc
  join public.referral_partners p on p.id=rc.partner_id
  join auth.users u on u.id=rc.customer_user_id
  where public.znv_is_admin() and rc.partner_id=p_partner_id
  order by rc.first_seen_at desc;
$$;
grant execute on function public.znv_admin_referral_customers(uuid) to authenticated;

-- Admin ortak onayı.
create or replace function public.znv_partner_approve(p_partner_id uuid)
returns public.referral_partners language plpgsql security definer set search_path=public as $$
declare v public.referral_partners;
begin
  if not public.znv_is_admin() then raise exception 'Yetkisiz'; end if;
  update public.referral_partners set status='approved',approved_at=coalesce(approved_at,now()),referral_code=case when referral_code like 'ZNV-%' then referral_code else 'ZNV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)) end where id=p_partner_id returning * into v;
  if v.id is null then raise exception 'Ortak bulunamadı'; end if;
  return v;
end $$;
grant execute on function public.znv_partner_approve(uuid) to authenticated;

-- Admin, Shopier siparişini ve referans müşterinin hesabını kontrol ettikten sonra doğrular.
create or replace function public.znv_admin_verify_referral_sale(p_partner_id uuid,p_shopier_order_id text,p_customer_email text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_customer uuid; v_sale uuid;
begin
  if not public.znv_is_admin() then raise exception 'Yetkisiz'; end if;
  if not exists(select 1 from public.referral_partners where id=p_partner_id and status='approved') then raise exception 'Ortak aktif değil'; end if;
  select u.id into v_customer from auth.users u join public.referral_customers rc on rc.customer_user_id=u.id where rc.partner_id=p_partner_id and lower(u.email)=lower(trim(p_customer_email)) limit 1;
  if v_customer is null then raise exception 'Bu e-posta bu ortağın doğrulanmış müşterileri arasında bulunamadı.'; end if;
  if trim(coalesce(p_shopier_order_id,''))='' then raise exception 'Shopier sipariş numarası gerekli.'; end if;
  insert into public.referral_sales(partner_id,customer_user_id,shopier_order_id,status,verified_by) values(p_partner_id,v_customer,trim(p_shopier_order_id),'verified',auth.uid()) returning id into v_sale;
  perform public.znv_recalc_referral_bonus(p_partner_id);
  return jsonb_build_object('ok',true,'sale_id',v_sale);
exception when unique_violation then raise exception 'Bu Shopier sipariş numarası daha önce doğrulanmış.';
end $$;
grant execute on function public.znv_admin_verify_referral_sale(uuid,text,text) to authenticated;

-- RLS: ortak kendi profilini okuyabilir. Adminler özet RPC üzerinden yönetir.
drop policy if exists referral_partner_self_read on public.referral_partners;
create policy referral_partner_self_read on public.referral_partners for select to authenticated using (user_id=auth.uid());

-- Ham müşteri/satış/bonus tablolarına doğrudan erişim yok; admin özetleri SECURITY DEFINER RPC ile alır.
drop policy if exists referral_customer_admin_read on public.referral_customers;
drop policy if exists referral_sales_admin_read on public.referral_sales;
drop policy if exists referral_bonus_admin_read on public.referral_bonus_ledger;

revoke all on public.referral_customers from anon,authenticated;
revoke all on public.referral_sales from anon,authenticated;
revoke all on public.referral_bonus_ledger from anon,authenticated;


-- V2: Yönetici panelinin kullandığı RPC'ler.
create or replace function public.znv_admin_referral_summary_v2()
returns table(
  id uuid, name text, email text, referral_code text, status text,
  customer_count integer, verified_sales integer, bonus_balance numeric
)
language sql security definer set search_path=public
as $$
  select
    p.id, p.name, p.email, p.referral_code, p.status,
    (select count(*)::integer from public.referral_customers rc where rc.partner_id=p.id),
    (select count(*)::integer from public.referral_sales rs where rs.partner_id=p.id and rs.status='verified'),
    coalesce((select sum(bl.bonus_amount) from public.referral_bonus_ledger bl where bl.partner_id=p.id),0)
  from public.referral_partners p
  where public.znv_is_admin()
  order by p.created_at desc;
$$;
grant execute on function public.znv_admin_referral_summary_v2() to authenticated;

create or replace function public.znv_admin_referral_customers_v2(p_partner_id uuid)
returns table(
  customer_user_id uuid, customer_email text, referral_code text,
  first_seen_at timestamptz, verified_sale boolean, shopier_order_id text
)
language sql security definer set search_path=public
as $$
  select
    rc.customer_user_id, u.email::text, p.referral_code, rc.first_seen_at,
    exists(
      select 1 from public.referral_sales s
      where s.partner_id=rc.partner_id
        and s.customer_user_id=rc.customer_user_id
        and s.status='verified'
    ) as verified_sale,
    (
      select s.shopier_order_id
      from public.referral_sales s
      where s.partner_id=rc.partner_id
        and s.customer_user_id=rc.customer_user_id
        and s.status='verified'
      order by s.verified_at desc
      limit 1
    ) as shopier_order_id
  from public.referral_customers rc
  join public.referral_partners p on p.id=rc.partner_id
  join auth.users u on u.id=rc.customer_user_id
  where public.znv_is_admin() and rc.partner_id=p_partner_id
  order by rc.first_seen_at desc;
$$;
grant execute on function public.znv_admin_referral_customers_v2(uuid) to authenticated;

create or replace function public.znv_admin_verify_referral_sale_v2(
  p_partner_id uuid, p_shopier_order_id text, p_customer_email text
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare v_customer uuid; v_sale uuid;
begin
  if not public.znv_is_admin() then raise exception 'Yetkisiz'; end if;
  if not exists(select 1 from public.referral_partners where id=p_partner_id and status='approved') then
    raise exception 'Ortak aktif değil';
  end if;
  if trim(coalesce(p_shopier_order_id,''))='' then raise exception 'Shopier sipariş numarası gerekli.'; end if;
  if trim(coalesce(p_customer_email,''))='' then raise exception 'Müşteri e-postası gerekli.'; end if;
  select u.id into v_customer
  from auth.users u
  join public.referral_customers rc on rc.customer_user_id=u.id
  where rc.partner_id=p_partner_id and lower(u.email)=lower(trim(p_customer_email))
  limit 1;
  if v_customer is null then
    raise exception 'Bu e-posta bu ortağın referansıyla gelen müşteriler arasında bulunamadı.';
  end if;
  insert into public.referral_sales(partner_id,customer_user_id,shopier_order_id,status,verified_by)
  values(p_partner_id,v_customer,trim(p_shopier_order_id),'verified',auth.uid())
  returning id into v_sale;
  perform public.znv_recalc_referral_bonus(p_partner_id);
  return jsonb_build_object('ok',true,'sale_id',v_sale);
exception when unique_violation then
  raise exception 'Bu Shopier sipariş numarası daha önce doğrulanmış.';
end;
$$;
grant execute on function public.znv_admin_verify_referral_sale_v2(uuid,text,text) to authenticated;

NOTIFY pgrst, 'reload schema';
