"""
热梗自动化系统配置

方案：网页表单录入 + 企微群 Webhook 推送通知
"""
import os
import pathlib

# ============ 服务配置 ============

# Flask 服务端口
SERVER_PORT = int(os.environ.get("SERVER_PORT", "5000"))

# Flask 服务监听地址
SERVER_HOST = os.environ.get("SERVER_HOST", "0.0.0.0")

# ============ 企微 Webhook 配置 ============

# 企微群机器人 Webhook 地址
# 在企微群 → 群设置 → 群机器人 → 添加机器人 → 获取 Webhook 地址
# 格式：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx
WEBHOOK_URL = os.environ.get("WECOM_WEBHOOK_URL", "")

# ============ 存储配置 ============

# 项目根目录
PROJECT_ROOT = pathlib.Path(__file__).parent.parent

# 热梗数据文件路径
MEMES_DATA_FILE = PROJECT_ROOT / "data" / "memes.json"

# 截图存储目录
IMAGES_DIR = PROJECT_ROOT / "images"

# 周报输出目录
OUTPUT_DIR = PROJECT_ROOT / "output"

# 周报模板目录
TEMPLATES_DIR = PROJECT_ROOT / "templates"

# ============ 图片配置 ============

# 允许上传的图片类型
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}

# 单张图片最大大小 (5MB)
MAX_IMAGE_SIZE = 5 * 1024 * 1024
