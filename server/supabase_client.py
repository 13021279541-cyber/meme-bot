"""
Supabase 客户端封装

提供热梗数据的 CRUD 操作和图片存储功能。
替代原来的本地 JSON + 本地图片方案。
"""
import os
import uuid
from datetime import datetime
from supabase import create_client, Client

# ============ Supabase 配置 ============

SUPABASE_URL = os.environ.get(
    "SUPABASE_URL",
    "https://iwmvtizwcibusjjiquwq.supabase.co"
)
SUPABASE_KEY = os.environ.get(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml3bXZ0aXp3Y2lidXNqamlxdXdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MjMxMDUsImV4cCI6MjA4OTk5OTEwNX0.E6dx_ewnrFXgnoMoWsu0Hk27RbByf3w8ztmb6C9XIOM"
)

STORAGE_BUCKET = "meme-images"

# 初始化客户端
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ============ 数据操作 ============

def load_all_memes() -> list:
    """加载所有热梗，按创建时间降序"""
    response = (
        supabase.table("memes")
        .select("*")
        .order("created_at", desc=True)
        .execute()
    )
    return response.data or []


def load_memes_by_week(year: int, week: int) -> list:
    """加载指定周的热梗"""
    response = (
        supabase.table("memes")
        .select("*")
        .eq("year", year)
        .eq("week_number", week)
        .order("created_at", desc=True)
        .execute()
    )
    return response.data or []


def load_memes_by_date_range(start_date: str, end_date: str) -> list:
    """
    加载指定日期范围的热梗
    start_date, end_date 格式: YYYY-MM-DD
    """
    start_dt = f"{start_date}T00:00:00"
    end_dt = f"{end_date}T23:59:59"
    response = (
        supabase.table("memes")
        .select("*")
        .gte("created_at", start_dt)
        .lte("created_at", end_dt)
        .order("created_at", desc=True)
        .execute()
    )
    return response.data or []


def insert_meme(meme: dict) -> dict:
    """插入一条热梗记录"""
    response = (
        supabase.table("memes")
        .insert(meme)
        .execute()
    )
    return response.data[0] if response.data else meme


def update_meme(meme_id: str, updates: dict) -> dict | None:
    """更新一条热梗（补录概括、分类、等级等）"""
    response = (
        supabase.table("memes")
        .update(updates)
        .eq("id", meme_id)
        .execute()
    )
    return response.data[0] if response.data else None


def delete_meme(meme_id: str) -> bool:
    """删除一条热梗"""
    response = (
        supabase.table("memes")
        .delete()
        .eq("id", meme_id)
        .execute()
    )
    return len(response.data) > 0 if response.data else False


# ============ 图片存储 ============

def upload_image(file_bytes: bytes, filename: str, content_type: str = "image/png") -> str:
    """
    上传图片到 Supabase Storage

    Returns:
        图片的公开 URL
    """
    # 生成唯一文件名
    ext = filename.rsplit(".", 1)[1].lower() if "." in filename else "png"
    unique_name = f"{uuid.uuid4().hex[:12]}.{ext}"
    path = f"uploads/{unique_name}"

    # 上传到 Storage
    supabase.storage.from_(STORAGE_BUCKET).upload(
        path=path,
        file=file_bytes,
        file_options={"content-type": content_type, "upsert": "false"}
    )

    # 获取公开 URL
    public_url = supabase.storage.from_(STORAGE_BUCKET).get_public_url(path)
    return public_url


def get_image_url(image_path: str) -> str:
    """
    获取图片的公开 URL
    
    兼容两种格式:
    - 旧格式: "images/xxx.png" (本地路径)
    - 新格式: "https://..." (已经是完整 URL)
    """
    if not image_path:
        return ""
    if image_path.startswith("http"):
        return image_path
    # 旧格式本地路径，返回相对路径（兼容未迁移的数据）
    return f"/{image_path}"
