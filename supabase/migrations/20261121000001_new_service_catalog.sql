-- ============================================================================
-- New service price list (the shop's printed price lists replace the old catalog).
--
-- What this does:
--   1. Replaces the built-in catalog the database uses to check booking prices
--      (catalog_builtin_services) and the minutes each service takes.
--      The browser's copy is frontend/src/data/servicesCatalog.js; scripts/verify-catalog-sync.mjs
--      fails if the two ever differ.
--   2. Teaches the database the new vehicle categories: Hatch, Sedan, AUV (AUV/MPV/Crossover), SUV,
--      Pickup, Van Small, Van Medium, Van Large, plus the unchanged Regular (motorcycle 400cc and
--      below) and Bigbike (above 400cc).
--   3. Replaces the add-on prerequisite (the hydrophobic wax upgrade needs Package A).
--   4. Clears the Business Hub's old additions: admin-added services, the archived and deleted
--      service lists, and the extra vehicle categories, because they refer to the old catalog.
--      Promotions are left alone; ones that name old services simply match nothing until ended.
-- Existing bookings keep the names, prices and times they were made with (they are stored on the booking).
-- ============================================================================

delete from public.catalog_builtin_services;
insert into public.catalog_builtin_services (service_id, name, category, vehicle_key, price) values
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'Hatch', 150),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'Sedan', 170),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'AUV', 200),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'SUV', 220),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'Pickup', 270),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'Van Small', 300),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'Van Medium', 320),
  ('wash_basic', 'Basic Carwash', 'Car Wash', 'Van Large', 350),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'Hatch', 230),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'Sedan', 250),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'AUV', 280),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'SUV', 300),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'Pickup', 350),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'Van Small', 380),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'Van Medium', 400),
  ('wash_premium', 'Premium All Carwash', 'Car Wash', 'Van Large', 430),
  ('pkg_a', 'Package A', 'Packages', 'Hatch', 750),
  ('pkg_a', 'Package A', 'Packages', 'Sedan', 850),
  ('pkg_a', 'Package A', 'Packages', 'AUV', 950),
  ('pkg_a', 'Package A', 'Packages', 'SUV', 1050),
  ('pkg_a', 'Package A', 'Packages', 'Pickup', 1150),
  ('pkg_a', 'Package A', 'Packages', 'Van Small', 1350),
  ('pkg_a', 'Package A', 'Packages', 'Van Medium', 1350),
  ('pkg_a', 'Package A', 'Packages', 'Van Large', 1350),
  ('pkg_b', 'Package B', 'Packages', 'Hatch', 1200),
  ('pkg_b', 'Package B', 'Packages', 'Sedan', 1300),
  ('pkg_b', 'Package B', 'Packages', 'AUV', 1400),
  ('pkg_b', 'Package B', 'Packages', 'SUV', 1600),
  ('pkg_b', 'Package B', 'Packages', 'Pickup', 1600),
  ('pkg_b', 'Package B', 'Packages', 'Van Small', 1800),
  ('pkg_b', 'Package B', 'Packages', 'Van Medium', 1800),
  ('pkg_b', 'Package B', 'Packages', 'Van Large', 1800),
  ('pkg_c', 'Package C', 'Packages', 'Hatch', 800),
  ('pkg_c', 'Package C', 'Packages', 'Sedan', 900),
  ('pkg_c', 'Package C', 'Packages', 'AUV', 1000),
  ('pkg_c', 'Package C', 'Packages', 'SUV', 1200),
  ('pkg_c', 'Package C', 'Packages', 'Pickup', 1200),
  ('pkg_c', 'Package C', 'Packages', 'Van Small', 1300),
  ('pkg_c', 'Package C', 'Packages', 'Van Medium', 1300),
  ('pkg_c', 'Package C', 'Packages', 'Van Large', 1300),
  ('pkg_d', 'Package D', 'Packages', 'Hatch', 450),
  ('pkg_d', 'Package D', 'Packages', 'Sedan', 550),
  ('pkg_d', 'Package D', 'Packages', 'AUV', 650),
  ('pkg_d', 'Package D', 'Packages', 'SUV', 750),
  ('pkg_d', 'Package D', 'Packages', 'Pickup', 850),
  ('pkg_d', 'Package D', 'Packages', 'Van Small', 1000),
  ('pkg_d', 'Package D', 'Packages', 'Van Medium', 1000),
  ('pkg_d', 'Package D', 'Packages', 'Van Large', 1000),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'Hatch', 250),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'Sedan', 300),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'AUV', 400),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'SUV', 500),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'Pickup', 500),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'Van Small', 600),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'Van Medium', 600),
  ('ext_asphalt', 'Asphalt, Bug and Tar Removal', 'Exterior Care', 'Van Large', 600),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'Hatch', 650),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'Sedan', 700),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'AUV', 800),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'SUV', 900),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'Pickup', 900),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'Van Small', 1100),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'Van Medium', 1100),
  ('ext_acid_full', 'Acid Rain Removal (Front, Side, Rear)', 'Exterior Care', 'Van Large', 1100),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'Hatch', 200),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'Sedan', 200),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'AUV', 300),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'SUV', 350),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'Pickup', 350),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'Van Small', 400),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'Van Medium', 400),
  ('ext_acid_wind', 'Acid Rain Removal (Windshield only)', 'Exterior Care', 'Van Large', 400),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'Hatch', 550),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'Sedan', 600),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'AUV', 700),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'SUV', 800),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'Pickup', 800),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'Van Small', 1000),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'Van Medium', 1000),
  ('ext_hydro_glass', 'Hydrophobic Glass Coating (Front, Side, Rear)', 'Exterior Care', 'Van Large', 1000),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'Hatch', 550),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'Sedan', 650),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'AUV', 750),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'SUV', 850),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'Pickup', 850),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'Van Small', 1100),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'Van Medium', 1100),
  ('ext_wax', 'Hand/Spray Wax', 'Exterior Care', 'Van Large', 1100),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'Hatch', 800),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'Sedan', 900),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'AUV', 1000),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'SUV', 1100),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'Pickup', 1100),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'Van Small', 1350),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'Van Medium', 1350),
  ('ext_buff', 'Buffing with Wax', 'Exterior Care', 'Van Large', 1350),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'Hatch', 700),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'Sedan', 750),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'AUV', 800),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'SUV', 900),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'Pickup', 900),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'Van Small', 1000),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'Van Medium', 1000),
  ('ext_engine', 'Engine Wash + Carwash', 'Exterior Care', 'Van Large', 1000),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'Hatch', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'Sedan', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'AUV', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'SUV', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'Pickup', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'Van Small', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'Van Medium', 500),
  ('ext_headlight', 'Headlight Exterior Polishing', 'Exterior Care', 'Van Large', 500),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'Hatch', 200),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'Sedan', 200),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'AUV', 250),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'SUV', 250),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'Pickup', 300),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'Van Small', 350),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'Van Medium', 350),
  ('int_armor', 'Armor All Protectant (Interior)', 'Interior Care', 'Van Large', 350),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'Hatch', 300),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'Sedan', 400),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'AUV', 500),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'SUV', 600),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'Pickup', 600),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'Van Small', 700),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'Van Medium', 700),
  ('int_bac0', 'Bac To Zero', 'Interior Care', 'Van Large', 700),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'Hatch', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'Sedan', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'AUV', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'SUV', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'Pickup', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'Van Small', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'Van Medium', 450),
  ('int_seat', 'Seat Shampoo (Per Seat)', 'Interior Care', 'Van Large', 450),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'Hatch', 500),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'Sedan', 500),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'AUV', 600),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'SUV', 600),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'Pickup', 600),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'Van Small', 1000),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'Van Medium', 1000),
  ('int_ceiling', 'Ceiling Cleaning', 'Interior Care', 'Van Large', 1000),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'Hatch', 500),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'Sedan', 500),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'AUV', 600),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'SUV', 600),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'Pickup', 600),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'Van Small', 1000),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'Van Medium', 1000),
  ('int_carpet', 'Carpet Cleaning', 'Interior Care', 'Van Large', 1000),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'Hatch', 1500),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'Sedan', 1500),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'AUV', 1700),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'SUV', 2000),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'Pickup', 2000),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'Van Small', 2500),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'Van Medium', 2500),
  ('int_remove', 'Carpet and Seats Removal', 'Interior Care', 'Van Large', 2500),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'Hatch', 3000),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'Sedan', 3000),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'AUV', 4000),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'SUV', 4500),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'Pickup', 4500),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'Van Small', 5000),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'Van Medium', 5000),
  ('det_int_ord', 'Interior Detailing Ordinary (No Baklas)', 'Detailing', 'Van Large', 5000),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'Hatch', 4500),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'Sedan', 4500),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'AUV', 5700),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'SUV', 6500),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'Pickup', 6500),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'Van Small', 7500),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'Van Medium', 7500),
  ('det_int_baklas', 'Interior Detailing with Remove and Install (With Baklas)', 'Detailing', 'Van Large', 7500),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'Hatch', 4500),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'Sedan', 5500),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'AUV', 6500),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'SUV', 8000),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'Pickup', 8000),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'Van Small', 9000),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'Van Medium', 9000),
  ('det_ext', 'Exterior Detailing', 'Detailing', 'Van Large', 9000),
  ('det_pkg', 'Detailing Package', 'Detailing', 'Hatch', 7000),
  ('det_pkg', 'Detailing Package', 'Detailing', 'Sedan', 8000),
  ('det_pkg', 'Detailing Package', 'Detailing', 'AUV', 10000),
  ('det_pkg', 'Detailing Package', 'Detailing', 'SUV', 12000),
  ('det_pkg', 'Detailing Package', 'Detailing', 'Pickup', 12000),
  ('det_pkg', 'Detailing Package', 'Detailing', 'Van Small', 13500),
  ('det_pkg', 'Detailing Package', 'Detailing', 'Van Medium', 13500),
  ('det_pkg', 'Detailing Package', 'Detailing', 'Van Large', 13500),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'Hatch', 150),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'Sedan', 200),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'AUV', 250),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'SUV', 300),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'Pickup', 300),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'Van Small', 350),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'Van Medium', 350),
  ('lab_spray', 'Labor Only - Spray and Wipe', 'Labor Only', 'Van Large', 350),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'Hatch', 300),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'Sedan', 400),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'AUV', 500),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'SUV', 600),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'Pickup', 600),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'Van Small', 850),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'Van Medium', 850),
  ('lab_wax', 'Labor Only - Wax and Wipe', 'Labor Only', 'Van Large', 850),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'Hatch', 450),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'Sedan', 500),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'AUV', 600),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'SUV', 700),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'Pickup', 700),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'Van Small', 800),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'Van Medium', 800),
  ('lab_acid', 'Labor Only - Acid Rain Removal (Glass - Front, Side, Rear)', 'Labor Only', 'Van Large', 800),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'Hatch', 100),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'Sedan', 150),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'AUV', 200),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'SUV', 250),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'Pickup', 250),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'Van Small', 300),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'Van Medium', 300),
  ('lab_hydro', 'Labor Only - Hydrophobic Water Repellent Protectant (Glass - Front, Side, Rear)', 'Labor Only', 'Van Large', 300),
  ('moto_wash_s', 'Premium Bike Wash (Small)', 'Motorcycle Specialist', 'Regular', 100),
  ('moto_wash_m', 'Premium Bike Wash (Medium)', 'Motorcycle Specialist', 'Regular', 130),
  ('moto_wash_l', 'Premium Bike Wash (Large)', 'Motorcycle Specialist', 'Regular', 150),
  ('moto_wash_big', 'Premium Bike Wash (Above 400cc)', 'Motorcycle Specialist', 'Bigbike', 250),
  ('moto_armor', 'Bike Armor All Protectant', 'Motorcycle Specialist', 'Regular', 100),
  ('moto_armor', 'Bike Armor All Protectant', 'Motorcycle Specialist', 'Bigbike', 150),
  ('moto_wax', 'Bike Spray Wax', 'Motorcycle Specialist', 'Regular', 150),
  ('moto_wax', 'Bike Spray Wax', 'Motorcycle Specialist', 'Bigbike', 200),
  ('moto_buff', 'Bike Buff and Wax', 'Motorcycle Specialist', 'Regular', 250),
  ('moto_buff', 'Bike Buff and Wax', 'Motorcycle Specialist', 'Bigbike', 300),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'Hatch', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'Sedan', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'AUV', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'SUV', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'Pickup', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'Van Small', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'Van Medium', 100),
  ('add_hydro_wax', 'Hydrophobic Wax Upgrade (Package A)', 'Add-on Treatments', 'Van Large', 100);

-- Minutes each service takes (the booking length and the capacity check use these).
update public.catalog_builtin_services as c set duration_minutes = v.minutes
from (values
  ('wash_basic', 45),
  ('wash_premium', 90),
  ('pkg_a', 180),
  ('pkg_b', 240),
  ('pkg_c', 150),
  ('pkg_d', 120),
  ('ext_asphalt', 60),
  ('ext_acid_full', 90),
  ('ext_acid_wind', 30),
  ('ext_hydro_glass', 60),
  ('ext_wax', 60),
  ('ext_buff', 120),
  ('ext_engine', 90),
  ('ext_headlight', 45),
  ('int_armor', 30),
  ('int_bac0', 60),
  ('int_seat', 30),
  ('int_ceiling', 60),
  ('int_carpet', 60),
  ('int_remove', 120),
  ('det_int_ord', 300),
  ('det_int_baklas', 480),
  ('det_ext', 480),
  ('det_pkg', 720),
  ('lab_spray', 30),
  ('lab_wax', 60),
  ('lab_acid', 60),
  ('lab_hydro', 30),
  ('moto_wash_s', 45),
  ('moto_wash_m', 45),
  ('moto_wash_l', 60),
  ('moto_wash_big', 60),
  ('moto_armor', 30),
  ('moto_wax', 45),
  ('moto_buff', 120),
  ('add_hydro_wax', 30)
) as v(service_id, minutes)
where c.service_id = v.service_id;

-- Canonical vehicle category key (same aliases as the browser's priceVehicleKey).
create or replace function public.catalog_vehicle_key(p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_raw text := btrim(coalesce(p_value, ''));
  v_norm text;
  v_flat text;
begin
  if v_raw = '' then return ''; end if;
  v_norm := btrim(regexp_replace(regexp_replace(lower(v_raw), '[_/-]+', ' ', 'g'), '\s+', ' ', 'g'));
  v_flat := replace(v_norm, ' ', '');
  return case
    when v_norm in ('hatch', 'hatchback', 'hatch back') then 'Hatch'
    when v_norm in ('sedan', 'sedan hatchback') or v_flat = 'sedan' then 'Sedan'
    when v_norm in ('auv', 'mpv', 'crossover', 'auv mpv crossover') then 'AUV'
    when v_norm in ('suv', 'suv crossover') then 'SUV'
    when v_norm in ('pickup', 'pick up') then 'Pickup'
    when v_norm in ('van small', 'van (small)') then 'Van Small'
    when v_norm in ('van medium', 'van (medium)', 'van', 'van l300', 'pickup van') or v_flat in ('vanl300', 'pickupvan') then 'Van Medium'
    when v_norm in ('van large', 'van (large)') then 'Van Large'
    when v_norm in ('regular', 'motorcycle', 'motorcycle regular', 'moto') or v_flat in ('motorcycleregular') then 'Regular'
    when v_norm in ('bigbike', 'big bike') or v_flat = 'bigbike' then 'Bigbike'
    else v_raw
  end;
end;
$$;

-- The AUV/MPV/Crossover category counts as an SUV for the master vehicle type.
create or replace function public.normalize_vehicle_type(p_label text)
returns public.vehicle_type
language plpgsql
immutable
set search_path = public, extensions
as $$
declare
  v_key text := lower(btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')));
begin
  if v_key = '' then
    return null;
  end if;
  return case v_key
    when 'sedan'          then 'sedan'::public.vehicle_type
    when 'sedan/hatchback' then 'sedan'::public.vehicle_type
    when 'hatchback'      then 'sedan'::public.vehicle_type
    when 'hatch'          then 'sedan'::public.vehicle_type
    when 'suv'            then 'suv'::public.vehicle_type
    when 'suv/crossover'  then 'suv'::public.vehicle_type
    when 'crossover'      then 'suv'::public.vehicle_type
    when 'auv'            then 'suv'::public.vehicle_type
    when 'auv/mpv/crossover' then 'suv'::public.vehicle_type
    when 'van'            then 'van'::public.vehicle_type
    when 'van/l300'       then 'van'::public.vehicle_type
    when 'van / l300'     then 'van'::public.vehicle_type
    when 'l300'           then 'van'::public.vehicle_type
    when 'pickup'         then 'van'::public.vehicle_type
    when 'pickup/van'     then 'van'::public.vehicle_type
    when 'truck'          then 'van'::public.vehicle_type
    when 'regular'        then 'motorcycle'::public.vehicle_type
    when 'motorcycle'     then 'motorcycle'::public.vehicle_type
    when 'motorbike'      then 'motorcycle'::public.vehicle_type
    when 'bigbike'        then 'motorcycle'::public.vehicle_type
    when 'big bike'       then 'motorcycle'::public.vehicle_type
    when 'big_bike'       then 'motorcycle'::public.vehicle_type
    else
      case
        when v_key like '%motor%' or v_key like '%bike%' or v_key like '%bigbike%'
          then 'motorcycle'::public.vehicle_type
        when v_key like '%van%' or v_key like '%pickup%' or v_key like '%truck%'
          then 'van'::public.vehicle_type
        when v_key like '%suv%' or v_key like '%crossover%' or v_key like '%auv%'
          then 'suv'::public.vehicle_type
        else 'sedan'::public.vehicle_type
      end
  end;
end;
$$;

-- Add-on prerequisites for the new catalog.
delete from public.service_requirements;
insert into public.service_requirements (service_name, requires_any) values
  ('Hydrophobic Wax Upgrade (Package A)', array['Package A']);

-- The Business Hub starts from the new price list: no admin additions, no archived or deleted ids, no extra categories.
update public.business_config
   set custom_services = '[]'::jsonb,
       archived_service_ids = '[]'::jsonb,
       deleted_service_ids = '[]'::jsonb,
       vehicle_types = '[]'::jsonb;
