-- LOCAL scratch stack only (never production): the storage buckets and access rules the app expects.
--
--   docker exec -i supabase_db_speedway-ledger-test psql -U postgres -v ON_ERROR_STOP=1 < scripts/sql/local-storage-setup.sql
--
-- Needs the local stack started WITH the storage service (do not exclude storage-api when running "supabase start").
-- The buckets and the eight rules on storage.objects are the ones production has (read from a schema-only dump of the
-- linked project). The service-proofs bucket and its four rules are also in the repo migrations; the others were set up
-- outside the migrations, which is why they are written out here. Safe to run again.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('service-proofs', 'service-proofs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit)
values ('payment-receipts', 'payment-receipts', true, 10485760)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat_media', 'chat_media', true, 5242880)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

drop policy if exists "Authenticated users can upload chat media" on storage.objects;
CREATE POLICY "Authenticated users can upload chat media" ON "storage"."objects" FOR INSERT WITH CHECK ((("bucket_id" = 'chat_media'::"text") AND ("auth"."role"() = 'authenticated'::"text")));

drop policy if exists "Authenticated users can upload payment receipts" on storage.objects;
CREATE POLICY "Authenticated users can upload payment receipts" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'payment-receipts'::"text"));

drop policy if exists "Authenticated users can upload receipts" on storage.objects;
CREATE POLICY "Authenticated users can upload receipts" ON "storage"."objects" FOR INSERT WITH CHECK ((("bucket_id" = 'receipts'::"text") AND ("auth"."role"() = 'authenticated'::"text")));

drop policy if exists "Customers can view their payment receipts" on storage.objects;
CREATE POLICY "Customers can view their payment receipts" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'payment-receipts'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."bookings" "b"
  WHERE ((("b"."id")::"text" = ("storage"."foldername"("objects"."name"))[2]) AND ("b"."customer_id" = "auth"."uid"()))))));

drop policy if exists "service_proofs_delete_admin" on storage.objects;
CREATE POLICY "service_proofs_delete_admin" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'service-proofs'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("upper"("p"."role") = 'ADMIN'::"text"))))));

drop policy if exists "service_proofs_insert_scoped" on storage.objects;
CREATE POLICY "service_proofs_insert_scoped" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'service-proofs'::"text") AND ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("upper"("p"."role") = 'ADMIN'::"text")))) OR ((("storage"."foldername"("name"))[3] = ANY (ARRAY['before'::"text", 'after'::"text"])) AND "public"."staff_booking_has_verified_downpayment"((("storage"."foldername"("name"))[1])::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."bookings" "b"
     JOIN "public"."booking_vehicles" "v" ON (("v"."booking_id" = "b"."id")))
  WHERE ((("b"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("b"."staff_id" = "auth"."uid"()) AND (("v"."id")::"text" = ("storage"."foldername"("objects"."name"))[2]) AND (((("storage"."foldername"("objects"."name"))[3] = 'before'::"text") AND ("upper"("v"."status") = ANY (ARRAY['PENDING'::"text", 'SCHEDULED'::"text", 'CONFIRMED'::"text"]))) OR ((("storage"."foldername"("objects"."name"))[3] = 'after'::"text") AND ("upper"("v"."status") = 'IN_PROGRESS'::"text"))) AND (NOT "public"."vehicle_has_photo_phase"("v"."id", ("storage"."foldername"("objects"."name"))[3])))))))));

drop policy if exists "service_proofs_read_scoped" on storage.objects;
CREATE POLICY "service_proofs_read_scoped" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'service-proofs'::"text") AND ((EXISTS ( SELECT 1
   FROM "public"."bookings" "b"
  WHERE ((("b"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("b"."customer_id" = "auth"."uid"())))) OR ((EXISTS ( SELECT 1
   FROM "public"."bookings" "b"
  WHERE ((("b"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("b"."staff_id" = "auth"."uid"())))) AND "public"."staff_booking_has_verified_downpayment"((("storage"."foldername"("name"))[1])::"uuid")) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("upper"("p"."role") = 'ADMIN'::"text")))))));

drop policy if exists "service_proofs_update_admin" on storage.objects;
CREATE POLICY "service_proofs_update_admin" ON "storage"."objects" FOR UPDATE TO "authenticated" USING ((("bucket_id" = 'service-proofs'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("upper"("p"."role") = 'ADMIN'::"text")))))) WITH CHECK ((("bucket_id" = 'service-proofs'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("upper"("p"."role") = 'ADMIN'::"text"))))));

-- added by migration 20261207000001 (after the production dump this file was built from)
-- A technician can clear a photo file they uploaded themselves while no photo record uses it.
--
-- Uploading a service photo stores the file first and records it second. If the second step fails (a lost connection,
-- or a phone clock that unlocks the picker a little early), the page tries to remove the file it just stored. Only
-- administrators could delete files, so that clean-up silently failed and the file stayed in storage with no record.
--
-- This rule allows exactly that clean-up and nothing more: the person who stored the file, while no photo record points
-- at it. Once a photo is recorded it can only be removed by an administrator or by the retention routine.

drop policy if exists "service_proofs_delete_own_unrecorded" on storage.objects;
create policy "service_proofs_delete_own_unrecorded"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'service-proofs'
    and owner_id = (select auth.uid())::text
    and not exists (
      select 1
        from public.service_photos sp
       where sp.storage_path = storage.objects.name
    )
  );

select id, public, file_size_limit from storage.buckets order by id;
