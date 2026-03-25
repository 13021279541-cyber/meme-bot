"""
热梗自动化 - Web 服务

方案：网页表单录入 + Supabase 云存储 + 企微群 Webhook 推送通知

功能：
1. GET  /                → 热梗录入表单页面
2. POST /api/meme        → 接收表单提交（截图上传至 Supabase Storage）
3. GET  /api/memes       → 查看所有热梗列表（JSON）
4. GET  /api/memes/week  → 查看本周热梗
5. POST /api/report      → 手动触发周报生成

启动：
    python server/app.py
"""
import sys
import os
import uuid
from datetime import datetime
from pathlib import Path

# 确保能 import 同目录模块（兼容直接运行和 gunicorn 两种方式）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, request, jsonify, render_template, send_from_directory

try:
    from server.config import (
        SERVER_HOST, SERVER_PORT,
        ALLOWED_EXTENSIONS, MAX_IMAGE_SIZE, IMAGES_DIR
    )
    from server.webhook import send_webhook_notification
    from server.supabase_client import (
        load_all_memes, load_memes_by_week, load_memes_by_date_range,
        insert_meme, update_meme as sb_update_meme, delete_meme as sb_delete_meme,
        upload_image, get_image_url
    )
except ImportError:
    from config import (
        SERVER_HOST, SERVER_PORT,
        ALLOWED_EXTENSIONS, MAX_IMAGE_SIZE, IMAGES_DIR
    )
    from webhook import send_webhook_notification
    from supabase_client import (
        load_all_memes, load_memes_by_week, load_memes_by_date_range,
        insert_meme, update_meme as sb_update_meme, delete_meme as sb_delete_meme,
        upload_image, get_image_url
    )

# 项目根目录
PROJECT_ROOT = Path(__file__).parent.parent

app = Flask(
    __name__,
    template_folder=str(PROJECT_ROOT / "templates"),
    static_folder=str(PROJECT_ROOT / "static"),
)
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_SIZE


# ===================== 辅助函数 =====================

def allowed_file(filename: str) -> bool:
    """检查文件扩展名是否合法"""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ===================== 页面路由 =====================

@app.route("/")
def index():
    """录入表单首页"""
    return render_template("index.html")


@app.route("/images/<path:filename>")
def serve_image(filename):
    """提供已上传的本地图片（兼容旧数据）"""
    return send_from_directory(str(IMAGES_DIR), filename)


@app.route("/output/<path:filename>")
def serve_output(filename):
    """提供生成的周报"""
    return send_from_directory(str(PROJECT_ROOT / "output"), filename)


# ===================== API 路由 =====================

@app.route("/api/meme", methods=["POST"])
def create_meme():
    """
    录入一条热梗

    表单字段：
    - name: 梗名称（必填）
    - summary: 一句话概括（选填，可后续补录）
    - source_url: 来源链接（必填）
    - contributor: 贡献者名称（必填）
    - category: 分类（wangzhe / public）
    - image: 截图文件（必填）
    """
    name = request.form.get("name", "").strip()
    summary = request.form.get("summary", "").strip()
    source_url = request.form.get("source_url", "").strip()
    contributor = request.form.get("contributor", "").strip()
    category = request.form.get("category", "").strip()

    # 校验必填字段
    if not name:
        return jsonify({"ok": False, "error": "请填写梗名称"}), 400
    if not source_url:
        return jsonify({"ok": False, "error": "请填写来源链接"}), 400
    if not contributor:
        return jsonify({"ok": False, "error": "请填写你的名字"}), 400

    # 处理截图上传（必传）
    image_path = ""
    image_file = request.files.get("image")
    if not image_file or not image_file.filename:
        return jsonify({"ok": False, "error": "请上传截图"}), 400

    if not allowed_file(image_file.filename):
        return jsonify({"ok": False, "error": "不支持的图片格式，请上传 png/jpg/gif/webp"}), 400

    # 上传到 Supabase Storage
    try:
        ext = image_file.filename.rsplit(".", 1)[1].lower()
        content_type = image_file.content_type or f"image/{ext}"
        file_bytes = image_file.read()
        image_path = upload_image(file_bytes, image_file.filename, content_type)
    except Exception as e:
        print(f"[WARN] Supabase Storage 上传失败，回退到本地存储: {e}")
        # 回退到本地存储
        image_file.seek(0)
        ext = image_file.filename.rsplit(".", 1)[1].lower()
        filename = f"{uuid.uuid4().hex[:12]}.{ext}"
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        save_path = IMAGES_DIR / filename
        image_file.save(str(save_path))
        image_path = f"images/{filename}"

    # 创建记录
    now = datetime.now()
    meme = {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "summary": summary,
        "source_url": source_url,
        "contributor": contributor,
        "category": category,
        "priority": "",
        "image_path": image_path,
        "created_at": now.isoformat(),
        "week_number": now.isocalendar()[1],
        "year": now.year,
    }

    # 保存到 Supabase
    try:
        insert_meme(meme)
    except Exception as e:
        return jsonify({"ok": False, "error": f"保存失败: {str(e)}"}), 500

    # 企微群 Webhook 通知
    send_webhook_notification(
        meme_name=name,
        meme_summary=summary,
        contributor=contributor,
        has_image=bool(image_path),
    )

    return jsonify({
        "ok": True,
        "message": f"✅ 已记录热梗：{name}",
        "meme": meme,
    })


@app.route("/api/memes", methods=["GET"])
def list_memes():
    """获取所有热梗列表"""
    try:
        memes = load_all_memes()
        # 处理图片 URL
        for m in memes:
            m["image_url"] = get_image_url(m.get("image_path", ""))
        return jsonify({"ok": True, "total": len(memes), "memes": memes})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/memes/week", methods=["GET"])
def list_week_memes():
    """获取本周热梗"""
    year = request.args.get("year", type=int, default=datetime.now().year)
    week = request.args.get("week", type=int, default=datetime.now().isocalendar()[1])

    try:
        memes = load_memes_by_week(year, week)
        for m in memes:
            m["image_url"] = get_image_url(m.get("image_path", ""))
        return jsonify({
            "ok": True,
            "year": year,
            "week": week,
            "total": len(memes),
            "memes": memes,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/meme/<meme_id>", methods=["PATCH"])
def update_meme_route(meme_id):
    """更新一条热梗（补录概括、分类、等级等）"""
    data = request.get_json(silent=True) or {}
    updates = {}

    if "summary" in data:
        updates["summary"] = data["summary"].strip()
    if "category" in data:
        updates["category"] = data["category"].strip()
    if "priority" in data:
        updates["priority"] = data["priority"].strip()

    if not updates:
        return jsonify({"ok": False, "error": "没有要更新的字段"}), 400

    try:
        result = sb_update_meme(meme_id, updates)
        if result:
            return jsonify({"ok": True, "message": "已更新", "meme": result})
        return jsonify({"ok": False, "error": "未找到该热梗"}), 404
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/meme/<meme_id>", methods=["DELETE"])
def delete_meme_route(meme_id):
    """删除一条热梗"""
    try:
        success = sb_delete_meme(meme_id)
        if success:
            return jsonify({"ok": True, "message": "已删除"})
        return jsonify({"ok": False, "error": "未找到该热梗"}), 404
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/report/generate", methods=["POST"])
def generate_report_by_range():
    """按日期范围生成周报（过滤灰色，按等级排序）"""
    try:
        data = request.get_json(silent=True) or {}
        start_date = data.get("start_date", "")
        end_date = data.get("end_date", "")

        if not start_date or not end_date:
            return jsonify({"ok": False, "error": "请选择日期范围"}), 400

        # 从 Supabase 查询
        memes = load_memes_by_date_range(start_date, end_date)

        # 过滤灰色
        filtered = [m for m in memes if m.get("priority") != "gray"]

        if not filtered:
            return jsonify({"ok": False, "error": "该时间范围内没有可上报的热梗"}), 404

        # 按等级排序：红 > 橙 > 蓝 > 无等级
        priority_order = {"red": 0, "orange": 1, "blue": 2, "": 3}
        filtered.sort(key=lambda m: priority_order.get(m.get("priority", ""), 3))

        # 处理图片 URL（周报需要完整 URL）
        for m in filtered:
            img = m.get("image_path", "")
            if img and img.startswith("http"):
                m["image_path"] = img  # 已经是完整 URL
            # 本地路径保持不变，generate_report 会处理

        # 生成周报
        sys.path.insert(0, str(PROJECT_ROOT))
        from generate_report import generate_report_by_date_range

        output_path = generate_report_by_date_range(filtered, start_date, end_date)
        filename = Path(output_path).name

        return jsonify({
            "ok": True,
            "message": "周报已生成",
            "filename": filename,
            "url": f"/output/{filename}",
            "total": len(filtered),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/report", methods=["POST"])
def generate_report_api():
    """手动触发周报生成"""
    try:
        sys.path.insert(0, str(PROJECT_ROOT))

        year = request.json.get("year") if request.is_json else None
        week = request.json.get("week") if request.is_json else None

        now = datetime.now()
        year = year or now.year
        week = week or now.isocalendar()[1]

        memes = load_memes_by_week(year, week)
        if not memes:
            return jsonify({"ok": False, "error": f"第 {week} 周没有热梗数据"}), 404

        from generate_report import generate_report
        output_path = generate_report(memes, year, week)
        filename = Path(output_path).name

        return jsonify({
            "ok": True,
            "message": f"周报已生成",
            "filename": filename,
            "url": f"/output/{filename}",
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ===================== 启动 =====================

if __name__ == "__main__":
    print("[HOT] 热梗自动化系统启动")
    print(f"   地址: http://localhost:{SERVER_PORT}")
    print(f"   录入页面: http://localhost:{SERVER_PORT}/")
    print(f"   API: http://localhost:{SERVER_PORT}/api/memes")
    print(f"   数据存储: Supabase Cloud ☁️")
    print()

    from config import WEBHOOK_URL
    if WEBHOOK_URL:
        print(f"   [OK] 企微 Webhook 已配置")
    else:
        print(f"   [!] 企微 Webhook 未配置（录入不会推送到群里）")
        print(f"      设置方法：export WECOM_WEBHOOK_URL='你的webhook地址'")
    print()

    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=True)
