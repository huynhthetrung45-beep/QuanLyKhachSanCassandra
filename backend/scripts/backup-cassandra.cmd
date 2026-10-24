@echo off
REM ======================================================================
REM  Sao luu keyspace chat_ott TRUOC KHI chay migration (Windows CMD).
REM  Chay tu D:\ChatOTT:   backend\scripts\backup-cassandra.cmd
REM
REM  Khong sua du lieu nghiep vu. Script lam 3 viec:
REM   1) nodetool flush + snapshot: tao hard link cac SSTable hien tai trong
REM      volume Docker (data/chat_ott/<bang>-<id>/snapshots/<tag>/).
REM      Snapshot KHONG doi du lieu bang, nhung chiem dung luong dan khi SSTable goc bi compaction.
REM   2) Ban sao logic: COPY ... TO csv cho 4 bang cu (chi doc) + DESCRIBE KEYSPACE.
REM   3) Chep ra D:\ChatOTT\_backup\cassandra-<tag>\ va dem so dong de doi chieu voi audit.
REM ======================================================================
setlocal
set CT=chatott-cassandra
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TAG=%%i
set DEST=%~dp0..\..\_backup\cassandra-%TAG%

echo [1/4] Flush + snapshot "truoc-migration-%TAG%"
docker exec %CT% nodetool flush chat_ott || goto :fail
docker exec %CT% nodetool snapshot -t truoc-migration-%TAG% chat_ott || goto :fail

echo [2/4] Xuat schema va du lieu 4 bang cu ra CSV (chi doc)
docker exec %CT% mkdir -p /tmp/bk-%TAG% || goto :fail
docker exec %CT% sh -c "cqlsh -e 'DESCRIBE KEYSPACE chat_ott' > /tmp/bk-%TAG%/schema.cql" || goto :fail
for %%T in (users conversations conversations_by_user messages_by_conversation) do (
  docker exec %CT% cqlsh -e "COPY chat_ott.%%T TO '/tmp/bk-%TAG%/%%T.csv' WITH HEADER = TRUE" || goto :fail
)

echo [3/4] Chep ra %DEST%
docker cp %CT%:/tmp/bk-%TAG% "%DEST%" || goto :fail

echo [4/4] Doi chieu so dong (tru 1 dong tieu de): ky vong users=8, conversations=10, conversations_by_user=28, messages=472
for %%T in (users conversations conversations_by_user messages_by_conversation) do (
  for /f %%n in ('powershell -NoProfile -Command "(Import-Csv '%DEST%\%%T.csv').Count"') do echo    %%T: %%n dong
)
docker exec %CT% nodetool listsnapshots
echo.
echo Xong. Ban sao: %DEST%
echo Snapshot: truoc-migration-%TAG%  (xoa sau khi khong can: nodetool clearsnapshot -t truoc-migration-%TAG% chat_ott)
exit /b 0

:fail
echo LOI: sao luu khong hoan tat. KHONG chay migration.
exit /b 1
