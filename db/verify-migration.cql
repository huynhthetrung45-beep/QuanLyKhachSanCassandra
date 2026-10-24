-- File nay da duoc tach thanh 2 che do (cqlsh khong co lenh dieu kien):
--
--   TRUOC migration:  backend\scripts\verify-migration.cmd before
--                     (db\verify-before-migration.cql - chi bang/cot dang ton tai)
--   SAU migration:    backend\scripts\verify-migration.cmd after
--                     (db\verify-after-migration.cql - bang/cot moi va du lieu backfill)
--
-- Ca hai deu CHI DOC. File nay khong con truy van nao; chay no khong lam gi.
USE chat_ott;
