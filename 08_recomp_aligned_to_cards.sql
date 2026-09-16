-- ============================================================================
-- RECOMP BY HOUR — aligned to the cards shift rail
-- ============================================================================
-- Matches 07_reviewed_cards_manila_toggle.sql: same 2 PM - 3 AM window, same
-- shift-date rollback, same Mon-Fri filter on the shift START day.
--
-- Metabase variables:
--   {{grain}}       Text  (day | week | month)
--   {{start_date}}  Date, {{end_date}} Date
--   {{grader}}      Text, optional
--
-- ---------------------------------------------------------------------------
-- SHIFT DATE ATTRIBUTION  (the point of this rewrite)
-- ---------------------------------------------------------------------------
-- A shift that starts 2 PM Aug 21 runs past midnight. Work done at 12 AM,
-- 1 AM, and 2 AM on Aug 22 belongs to the Aug 21 shift, not to Aug 22.
--
-- DATEADD(hour, -3, completed_at)::date does this:
--   Aug 21  2:00 PM  -3h -> Aug 21 11:00 AM  -> shift_date Aug 21  ok
--   Aug 21 11:00 PM  -3h -> Aug 21  8:00 PM  -> shift_date Aug 21  ok
--   Aug 22  1:00 AM  -3h -> Aug 21 10:00 PM  -> shift_date Aug 21  ok  <-- rolls back
--   Aug 22  2:59 AM  -3h -> Aug 21 11:59 PM  -> shift_date Aug 21  ok  <-- rolls back
--   Aug 22  3:00 AM  -3h -> Aug 22 12:00 AM  -> shift_date Aug 22  ok  <-- boundary
--
-- The +3h on the upper date bound exists so the final shift's 12-3 AM tail
-- isn't clipped off the end of the range.
--
-- ---------------------------------------------------------------------------
-- OPEN ITEM: admin.operation_logs.finished_at timezone is UNVERIFIED.
--   Assumed tz-aware (::timestamp yields LA wall time). If it is naive UTC,
--   every hour bucket is off by 7-8h and the entire shift relocates. Verify:
--     SELECT MAX(finished_at) AS raw, MAX(finished_at)::timestamp AS as_ts
--     FROM admin.operation_logs
--     WHERE kind IN ('verify_estimate_card_value','estimate_card_value');
--   Identical => naive UTC => wrap in
--     CONVERT_TIMEZONE('UTC','America/Los_Angeles', ol.finished_at)
-- ============================================================================

WITH base AS (
    SELECT
        ol.finished_at::timestamp                                     AS completed_at,
        COALESCE(u.first_name || ' ' || u.last_name, '(unassigned)')   AS grader,
        DATEADD(hour, -3, ol.finished_at::timestamp)::date             AS shift_date,
        EXTRACT(HOUR FROM ol.finished_at::timestamp)::int              AS shift_hour
    FROM admin.operation_logs ol
    LEFT JOIN public.users u ON u.id = ol.user_id
    WHERE ol.kind IN ('verify_estimate_card_value', 'estimate_card_value')
      AND ol.note ILIKE '%Recomp:%'
      AND ol.finished_at::timestamp >= {{start_date}}::timestamp
      -- +3h so the final shift's 12-3 AM tail isn't clipped
      AND ol.finished_at::timestamp <  DATEADD(hour, 3, DATEADD(day, 1, {{end_date}}::timestamp))
),
filtered AS (
    SELECT *
    FROM base
    WHERE (shift_hour BETWEEN 14 AND 23 OR shift_hour BETWEEN 0 AND 2)  -- 2 PM - 3 AM
      AND EXTRACT(DOW FROM shift_date) BETWEEN 1 AND 5                  -- shift START day
      AND shift_date >= {{start_date}}
      AND shift_date <= {{end_date}}
      [[ AND grader = {{grader}} ]]
)
SELECT
    DATE_TRUNC({{grain}}, shift_date)::date                        AS period,
    COALESCE(grader, '★ TEAM TOTAL')                               AS grader,
    COUNT(*)                                                       AS total_comps,
    -- Scheduled portion: 2 PM - 11 PM. Hours past 11 PM are extra time.
    SUM(CASE WHEN shift_hour BETWEEN 14 AND 22 THEN 1 ELSE 0 END)  AS shift_total,
    SUM(CASE WHEN shift_hour = 14 THEN 1 ELSE 0 END)               AS "2-3pm",
    SUM(CASE WHEN shift_hour = 15 THEN 1 ELSE 0 END)               AS "3-4pm",
    SUM(CASE WHEN shift_hour = 16 THEN 1 ELSE 0 END)               AS "4-5pm",
    SUM(CASE WHEN shift_hour = 17 THEN 1 ELSE 0 END)               AS "5-6pm",
    SUM(CASE WHEN shift_hour = 18 THEN 1 ELSE 0 END)               AS "6-7pm",
    SUM(CASE WHEN shift_hour = 19 THEN 1 ELSE 0 END)               AS "7-8pm",
    SUM(CASE WHEN shift_hour = 20 THEN 1 ELSE 0 END)               AS "8-9pm",
    SUM(CASE WHEN shift_hour = 21 THEN 1 ELSE 0 END)               AS "9-10pm",
    SUM(CASE WHEN shift_hour = 22 THEN 1 ELSE 0 END)               AS "10-11pm",
    SUM(CASE WHEN shift_hour = 23 THEN 1 ELSE 0 END)               AS "11-12am",
    SUM(CASE WHEN shift_hour =  0 THEN 1 ELSE 0 END)               AS "12-1am",
    SUM(CASE WHEN shift_hour =  1 THEN 1 ELSE 0 END)               AS "1-2am",
    SUM(CASE WHEN shift_hour =  2 THEN 1 ELSE 0 END)               AS "2-3am",
    SUM(CASE WHEN shift_hour = 23 OR shift_hour <= 2
             THEN 1 ELSE 0 END)                                    AS extra_time,
    COUNT(DISTINCT shift_date)                                     AS shift_days
FROM filtered
GROUP BY GROUPING SETS ((1, 2), (1))
HAVING 1 = 1
  [[ AND {{grader}} = {{grader}} AND GROUPING(grader) = 0 ]]
ORDER BY 1 DESC, GROUPING(grader) DESC, 3 DESC;

-- ---------------------------------------------------------------------------
-- Column names match the dashboard's GHOURS keys exactly. If you rename an
-- alias here, rename the matching `k` in GHOURS or that hour silently reads 0
-- (normalizeGrader falls back to 0 on a missing key rather than erroring).
-- ---------------------------------------------------------------------------
