-- Representative read-only DBMS queries. Run after migrations.
-- Relationships and joins:
SELECT t.id,t.service_date,t.token_number,t.status,s.name AS service,u.name AS visitor
FROM queue_tokens t JOIN services s ON s.id=t.service_id JOIN users u ON u.id=t.visitor_id
ORDER BY t.id DESC LIMIT 20;

-- GROUP BY view, including average and median wait:
SELECT s.name,r.* FROM daily_service_report r JOIN services s ON s.id=r.service_id
WHERE r.service_date=CURRENT_DATE ORDER BY r.service_id;

-- Correlated subquery: waiting visitors in each open service:
SELECT s.name,(SELECT count(*) FROM queue_tokens t WHERE t.service_id=s.id AND t.service_date=CURRENT_DATE AND t.status='WAITING') AS waiting
FROM services s WHERE s.is_open;

-- Assignment relationship:
SELECT s.name AS service,c.name AS counter,u.name AS operator
FROM counter_assignments a JOIN counters c ON c.id=a.counter_id
JOIN services s ON s.id=c.service_id JOIN users u ON u.id=a.operator_id
ORDER BY s.id,c.id,u.id;

-- Query-plan evidence. Replace service ID 1 if needed. Save actual output for viva.
EXPLAIN (ANALYZE,BUFFERS)
SELECT id,token_number FROM queue_tokens
WHERE service_id=1 AND service_date=CURRENT_DATE AND status='WAITING'
ORDER BY token_number LIMIT 1;

-- Rollback demonstration affecting no saved data. Save the before/after output:
BEGIN;
SELECT id,is_open FROM services WHERE id=1;
UPDATE services SET is_open=NOT is_open WHERE id=1;
SELECT id,is_open FROM services WHERE id=1;
ROLLBACK;
SELECT id,is_open FROM services WHERE id=1;
