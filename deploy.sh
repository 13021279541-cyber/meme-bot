#!/bin/bash
# =============================================================
# meme-bot 一键部署脚本（不依赖 Knot CLI）
# 用法：在 CVM 上执行  bash /root/meme-bot/deploy.sh
# 作用：拉取最新代码 -> 同步到运行目录 -> 重启 PM2 服务 -> 健康检查
# =============================================================
set -e

REPO_DIR="/root/meme-bot"
RUN_DIR="/root/api-server"

echo "==> [1/6] 拉取最新代码"
cd "$REPO_DIR"
git fetch origin
git reset --hard origin/main

echo "==> [2/6] 同步 api-server 代码到运行目录"
cp -r "$REPO_DIR"/api-server/* "$RUN_DIR"/

echo "==> [3/6] 同步 aibot-client.js 到 PM2 期望的路径 (/root/aibot-client.js)"
cp "$RUN_DIR"/aibot-client.js /root/aibot-client.js

echo "==> [4/6] 同步静态前端页面"
cp "$REPO_DIR"/static_deploy/index.html "$RUN_DIR"/public/index.html

echo "==> [5/6] 重启服务（先清理游离进程占用的 3000 端口）"
cd "$RUN_DIR"
pm2 stop all || true
fuser -k 3000/tcp 2>/dev/null || true
sleep 1
pm2 start all
sleep 3

echo "==> [6/6] 健康检查"
echo -n "版本接口返回: "
curl -s http://127.0.0.1:3000/version || echo "（/version 无响应，请检查 pm2 logs）"
echo ""
echo "==> 部署完成 ✅"
echo "如需查看日志: pm2 logs"
