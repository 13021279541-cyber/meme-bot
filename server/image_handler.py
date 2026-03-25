"""
图片下载和管理

负责：
1. 从企微服务器下载图片（通过 media_id）
2. 保存到本地 images/ 目录
3. 返回本地路径供关联使用
"""
import os
import time
import requests
from pathlib import Path
from typing import Optional

from config import IMAGES_DIR, CORP_ID


class ImageHandler:
    """处理企微图片消息中的图片下载"""

    def __init__(self):
        self.images_dir = IMAGES_DIR
        self.images_dir.mkdir(parents=True, exist_ok=True)

    def download_image(self, pic_url: str = "", media_id: str = "",
                       access_token: str = "") -> Optional[str]:
        """
        下载图片到本地
        
        企微智能机器人推送的图片有两种获取方式：
        1. pic_url: 图片的临时 URL（有时效性）
        2. media_id: 通过企微 API 下载（需要 access_token）
        
        Args:
            pic_url: 图片临时 URL
            media_id: 媒体文件 ID
            access_token: 企微 API access_token
        
        Returns:
            本地图片路径（相对于项目根目录），下载失败返回 None
        """
        # 生成文件名：时间戳
        timestamp = int(time.time() * 1000)
        filename = f"meme_{timestamp}.jpg"
        save_path = self.images_dir / filename

        try:
            # 优先使用 pic_url
            if pic_url:
                return self._download_from_url(pic_url, save_path)
            
            # 否则通过 media_id 下载
            if media_id and access_token:
                return self._download_from_media_id(media_id, access_token, save_path)
            
            print(f"[ImageHandler] 无法下载图片：没有可用的 URL 或 media_id")
            return None

        except Exception as e:
            print(f"[ImageHandler] 下载图片失败: {e}")
            return None

    def _download_from_url(self, url: str, save_path: Path) -> Optional[str]:
        """从 URL 直接下载"""
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        
        save_path.write_bytes(resp.content)
        # 返回相对路径
        return f"images/{save_path.name}"

    def _download_from_media_id(self, media_id: str, access_token: str,
                                 save_path: Path) -> Optional[str]:
        """通过企微 API 下载"""
        url = (f"https://qyapi.weixin.qq.com/cgi-bin/media/get"
               f"?access_token={access_token}&media_id={media_id}")
        
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()

        # 检查是否返回了错误 JSON 而不是图片
        content_type = resp.headers.get("Content-Type", "")
        if "json" in content_type:
            error = resp.json()
            print(f"[ImageHandler] 企微 API 返回错误: {error}")
            return None

        save_path.write_bytes(resp.content)
        return f"images/{save_path.name}"

    def list_images(self) -> list:
        """列出所有已下载的图片"""
        if not self.images_dir.exists():
            return []
        return sorted([
            f"images/{f.name}" 
            for f in self.images_dir.iterdir() 
            if f.suffix.lower() in ('.jpg', '.jpeg', '.png', '.gif', '.webp')
        ])
