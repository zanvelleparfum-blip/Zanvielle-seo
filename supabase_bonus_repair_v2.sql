-- ZANVIELLE SATIŞ ORTAKLARI — YÖNETİCİ PANELİ ONARIMI V2
-- Bu dosya ödeme/webhook sistemi kurmaz. Shopier satışları yönetici tarafından doğrulanır.

create or replace function public.znv_is_admin()
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists(
    select 1 from public.admin_users
    where id=auth.uid() and active=true and role in ('admin','editor')
  );
$$;
grant execute on function public.znv_is_admin() to authenticated;

-- Yönetici ortak özetini döndürür.
create or replace function public.znv_admin_referral_summary_v2()
returns table(
  id uuid,
  name text,
  email text,
  referral_code text,
  status text,
  customer_count integer,
  verified_sales integer,
  bonus_balance numeric
)
language sql security definer set search_path=public
as $$
  select
    p.id,
    p.name,
    p.email,
    p.referral_code,
    p.status,
    (select count(*)::integer from public.referral_customers rc where rc.partner_id=p.id),
    (select count(*)::integer from public.referral_sales rs where rs.partner_id=p.id and rs.status='verified'),
    coalesce((select sum(bl.bonus_amount) from public.referral_bonus_ledger bl where bl.partner_id=p.id),0)
  from public.referral_partners p
  where public.znv_is_admin()
  order by p.created_at desc;
$$;
grant execute on function public.znv_admin_referral_summary_v2() to authenticated;

-- Belirli ortağın referansıyla gelen müşterileri yöneticiye gösterir.
create or replace function public.znv_admin_referral_customers_v2(p_partner_id uuid)
returns table(
  customer_user_id uuid,
  customer_email text,
  referral_code text,
  first_seen_at timestamptz,
  verified_sale boolean,
  shopier_order_id text
)
language sql security definer set search_path=public
as $$
  select
    rc.customer_user_id,
    u.email::text,
    p.referral_code,
    rc.first_seen_at,
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

-- Yönetici Shopier siparişini, referansla gelen müşteri hesabıyla eşleştirerek doğrular.
create or replace function public.znv_admin_verify_referral_sale_v2(
  p_partner_id uuid,
  p_shopier_order_id text,
  p_customer_email text
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_customer uuid;
  v_sale uuid;
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
  where rc.partner_id=p_partner_id
    and lower(u.email)=lower(trim(p_customer_email))
  limit 1;

  if v_customer is null then
    raise exception 'Bu e-posta bu ortağın referansıyla gelen müşteriler arasında bulunamadı.';
  end if;

  insert into public.referral_sales(
    partner_id, customer_user_id, shopier_order_id, status, verified_by
  ) values (
    p_partner_id, v_customer, trim(p_shopier_order_id), 'verified', auth.uid()
  ) returning id into v_sale;

  perform public.znv_recalc_referral_bonus(p_partner_id);
  return jsonb_build_object('ok',true,'sale_id',v_sale);
exception
  when unique_violation then
    raise exception 'Bu Shopier sipariş numarası daha önce doğrulanmış.';
end;
$$;
grant execute on function public.znv_admin_verify_referral_sale_v2(uuid,text,text) to authenticated;

-- PostgREST schema cache'ini yenile.
NOTIFY pgrst, 'reload schema';
