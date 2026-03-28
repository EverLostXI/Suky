@echo off
echo 正在启动本地服务器...
echo 请在浏览器中打开: http://localhost:8080
echo 按 Ctrl+C 停止服务器
python -m http.server 8080
pause
