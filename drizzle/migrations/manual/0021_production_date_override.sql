-- Change Production Date (manager correction): a bare shop-calendar date that, when set,
-- moves a completed Job to a different Daily Production day WITHOUT changing completed_at.
-- Additive + nullable → every existing Job keeps today's behavior (NULL = use completed_at).
-- Read only by dailyProduction(); never touches Dealer Check-In or QuickBooks.
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS production_date_override date;
