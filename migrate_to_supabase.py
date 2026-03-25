"""
数据迁移脚本：将本地 memes.json + images/ 迁移到 Supabase

运行一次即可，迁移完成后可删除。
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "server"))

from supabase_client import supabase, upload_image, STORAGE_BUCKET
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent
MEMES_FILE = PROJECT_ROOT / "data" / "memes.json"
IMAGES_DIR = PROJECT_ROOT / "images"


def migrate():
    # 加载本地数据
    if not MEMES_FILE.exists():
        print("❌ 没有找到 data/memes.json，无需迁移")
        return

    with open(MEMES_FILE, "r", encoding="utf-8") as f:
        memes = json.load(f)

    if not memes:
        print("❌ memes.json 为空，无需迁移")
        return

    print(f"📦 找到 {len(memes)} 条热梗记录，开始迁移...\n")

    success_count = 0
    for i, meme in enumerate(memes):
        meme_name = meme.get("name", "未命名")
        print(f"  [{i+1}/{len(memes)}] {meme_name}")

        # 迁移图片
        image_path = meme.get("image_path", "")
        if image_path and not image_path.startswith("http"):
            local_image = PROJECT_ROOT / image_path
            if local_image.exists():
                try:
                    ext = local_image.suffix.lstrip(".")
                    content_type = f"image/{ext}" if ext != "jpg" else "image/jpeg"
                    with open(local_image, "rb") as img_file:
                        file_bytes = img_file.read()
                    url = upload_image(file_bytes, local_image.name, content_type)
                    meme["image_path"] = url
                    print(f"    ✅ 图片已上传: {local_image.name}")
                except Exception as e:
                    print(f"    ⚠️ 图片上传失败: {e}")
            else:
                print(f"    ⚠️ 本地图片不存在: {image_path}")

        # 确保所有字段都存在
        meme.setdefault("summary", "")
        meme.setdefault("category", "")
        meme.setdefault("priority", "")
        meme.setdefault("image_path", "")

        # 写入 Supabase
        try:
            supabase.table("memes").insert(meme).execute()
            success_count += 1
            print(f"    ✅ 已写入数据库")
        except Exception as e:
            print(f"    ❌ 写入失败: {e}")

    print(f"\n🎉 迁移完成！成功 {success_count}/{len(memes)} 条")
    print(f"\n💡 提示：本地 data/memes.json 和 images/ 已不再使用，可以保留备份")


if __name__ == "__main__":
    migrate()
