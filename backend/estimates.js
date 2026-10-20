// Last 20 completed visits in the last seven days; exclude zero/negative or >4h samples.
// The enabled-counter count is capacity, not a promise that an operator is available.
export const serviceDirectorySql = `
 SELECT s.id, s.name, s.description, s.opening_hours AS hours, s.is_open AS "isOpen",
   COALESCE(q.waiting, 0)::integer AS "peopleWaiting",
   capacity.enabled::integer AS "activeCounters", samples.n::integer AS "sampleCount", samples.minutes::float AS "meanServiceMinutes",
   CASE WHEN s.is_open AND capacity.enabled > 0 AND samples.n >= 3
     THEN CEIL(COALESCE(q.waiting,0) * samples.minutes / capacity.enabled)::integer
     ELSE NULL END AS "estimatedWait"
 FROM services s
 LEFT JOIN LATERAL (
   SELECT count(*) AS waiting FROM queue_tokens t
   WHERE t.service_id = s.id AND t.service_date = CURRENT_DATE AND t.status IN ('WAITING','CALLED')
 ) q ON TRUE
 LEFT JOIN LATERAL (SELECT count(*) AS enabled FROM counters c WHERE c.service_id = s.id AND c.active) capacity ON TRUE
 LEFT JOIN LATERAL (
   SELECT count(*) AS n, avg(duration) AS minutes FROM (
     SELECT EXTRACT(EPOCH FROM (v.completed_at - v.started_at)) / 60.0 AS duration
     FROM service_visits v JOIN queue_tokens t ON t.id = v.token_id
     WHERE t.service_id = s.id AND t.status = 'COMPLETED'
       AND v.completed_at >= NOW() - INTERVAL '7 days'
       AND v.completed_at > v.started_at
       AND v.completed_at - v.started_at <= INTERVAL '4 hours'
     ORDER BY v.completed_at DESC LIMIT 20
   ) recent
 ) samples ON TRUE
 ORDER BY s.id
`
