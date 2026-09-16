/* 37819 — Order Card Queue
 *
 * WHAT TO CHANGE AND WHY
 *
 * Order 18504539 shows 25 raw cards on the Orders tab and returns nothing from
 * this question. It is `pending_release`, and relevant_orders admits only six
 * statuses — pending_release is not one of them. The order-number filter was
 * never the problem: an unfiltered run returned 1,437 cards and none of them
 * belonged to it.
 *
 * The Orders tab (35872) shows nine statuses. This question covers six. Every
 * order in the missing three expands to an empty table.
 *
 * Two edits below, marked CHANGED. Everything else is your original.
 */

WITH relevant_orders AS (
    SELECT o.id, o.number, ao.due_date, ao.status
    FROM public.orders o
    JOIN admin.orders ao ON ao.id = o.id
    WHERE o.kind IN ('submit','submit_and_return')
      AND ao.status IN (
            'pending_rescan','pending_grading','pending_customer_support',
            'pending_review','pending_rejection','pending_data_issue',
            /* CHANGED — the three the Orders tab shows and this question did not.
             * Keep this list in step with OSTATUS_COLOR in index.html and with
             * CARD_Q_STATUSES, which the dashboard uses to explain an empty
             * table rather than blaming the filter. */
            'pending_release','pending_authentication','pending_scan'
      )
      AND (
            /* CHANGED — these two guards exclude an order once its reveal email
             * has gone out or it has shipped, which is precisely the state a
             * pending_release order is in. Leaving them unqualified would
             * re-exclude the orders the status list just admitted.
             *
             * Released orders are exempt: for them, the email having been sent
             * is the normal condition, not a reason to hide the cards. */
            ao.status IN ('pending_release','pending_authentication','pending_scan')
         OR (o.kind = 'submit'            AND ao.ready_to_reveal_email_sent_at IS NULL)
         OR (o.kind = 'submit_and_return' AND ao.shipped_at IS NULL)
      )
      [[ AND o.number::text ILIKE '%' || {{order_number}} || '%' ]]
),
/* latest card_type task per card, scoped to those orders */
ct_task AS (
    SELECT card_id, task_id, task_status
    FROM (
        SELECT
            gt.card_id,
            gt.id     AS task_id,
            gt.status AS task_status,
            ROW_NUMBER() OVER (PARTITION BY gt.card_id
                               ORDER BY gt.created_at DESC, gt.id DESC) AS rn
        FROM admin.grading_tasks gt
        JOIN public.order_items oi ON oi.card_id = gt.card_id
        JOIN relevant_orders r     ON r.id = oi.order_id
        WHERE gt.kind = 'card_type'
    ) q
    WHERE rn = 1
)
SELECT
    'https://admin.arenaclub.com/orders/' || r.id || '/cards/' || c.id AS card_url,
    r.number                                     AS order_number,
    r.status                                     AS order_status,
    (CONVERT_TIMEZONE('UTC','America/Los_Angeles', r.due_date::timestamp))::date AS due_date,
    c.number                                     AS ac_number,
    COALESCE(ct.task_status, 'no task')          AS card_type_status,
    CASE
        WHEN ct.task_status IN ('approved','reviewer_override','done_skip_verify','done')
            THEN 'complete'
        ELSE 'needs card type'
    END                                          AS card_type_flag,
    CASE WHEN ct.task_id IS NOT NULL THEN
        'https://admin.arenaclub.com/grades/card_type/' || ct.task_id
        || '?returnUrl=%2Forders%2F' || r.id || '%2Fcards%2F' || c.id
    END                                          AS card_type_task_url,
    c.status                                     AS card_status,
    c.is_pre_graded,
    c.player_name,
    c.year,
    c.brand,
    c.set_name,
    c.set_number,
    c.sport
FROM public.order_items oi
JOIN relevant_orders r ON r.id = oi.order_id
JOIN admin.cards    c  ON c.id = oi.card_id
LEFT JOIN ct_task   ct ON ct.card_id = c.id
WHERE c.status <> 'archived'
ORDER BY
    CASE
        WHEN ct.task_status IN ('approved','reviewer_override','done_skip_verify','done')
            THEN 1 ELSE 0
    END,
    r.number,
    c.number;

/* HOW TO CHECK IT
 *
 *   1. Run with Order Number = 18504539. Expect 25 rows. It returns 0 today.
 *   2. Run with Order Number = 18554823. Expect the same 25 rows as now —
 *      the edit must not change an order that already worked.
 *   3. Run bare. The row count should rise from 1,437; the increase is the
 *      cards on orders in the three added statuses.
 *
 * 37687 (Orders Queue) very likely carries the same status filter — it is the
 * source of the per-step grading state. If a pending_release order lists its
 * cards after this change but shows dashes down the CROP…REVIEW columns, that
 * question needs the same widening.
 */
