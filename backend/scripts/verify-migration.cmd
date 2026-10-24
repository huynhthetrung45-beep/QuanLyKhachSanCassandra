@echo off
REM Kiem tra CHI DOC truoc / sau migration.  Cach dung:
REM   backend\scripts\verify-migration.cmd before [001^|002]
REM   backend\scripts\verify-migration.cmd after  [001^|002]
REM Bo trong so migration = 002 (migration moi nhat).
setlocal
set MODE=%~1
set MIG=%~2
if "%MIG%"=="" set MIG=002
if /i not "%MODE%"=="before" if /i not "%MODE%"=="after" (
  echo Cach dung: %~nx0 before^|after [001^|002]
  exit /b 2
)
if "%MIG%"=="001" (
  set FILE=%~dp0..\..\db\verify-%MODE%-migration.cql
) else (
  set FILE=%~dp0..\..\db\verify-%MIG%-%MODE%.cql
)
if not exist "%FILE%" (
  echo Khong co file kiem tra: %FILE%
  exit /b 2
)
echo === Kiem tra %MODE% migration %MIG%: %FILE% ===
docker exec -i chatott-cassandra cqlsh < "%FILE%"
exit /b %ERRORLEVEL%
