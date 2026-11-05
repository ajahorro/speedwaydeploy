-- 20261222000001_keep_backend_awake.sql
-- ============================================================================
-- Keep the Render backend (comargarage-backend, free plan) from going to sleep.
--
-- Render's free web services spin down after 15 minutes without inbound
-- traffic and take about a minute to wake, which made the first booking or
-- payment action of a quiet period wait. pg_cron + pg_net (both already in
-- use on this project, both free) call GET /api/health every 10 minutes so the
-- service never goes idle long enough to sleep.
--
-- Cost: none in money. It does keep the free instance running all month,
-- which uses ~744 of the workspace's 750 free instance hours. Any other free
-- Render service in the same workspace shares those hours; if they run out,
-- Render suspends every free service until the next month. To stop the pings:
--   select cron.unschedule('keep_backend_awake');
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- cron.schedule with an existing job name updates that job, so re-running is safe.
select cron.schedule(
  'keep_backend_awake',
  '*/10 * * * *',
  $cron$
    select net.http_get(
      url := 'https://comargarage-backend.onrender.com/api/health',
      timeout_milliseconds := 60000
    );
  $cron$
);
