@echo off
rem Double-click to run Essay Desk on this Windows PC. Keep this window open while you use it.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org then run this again. & pause & exit /b 1)
if not exist node_modules (echo Installing for the first time... & call npm install || (pause & exit /b 1))
if not exist .env copy .env.example .env >nul
start "" http://localhost:5178
call npm start
pause
