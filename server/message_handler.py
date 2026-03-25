"""
消息解析和热梗数据管理

负责：
1. 解析企微推送的 XML 消息
2. 提取热梗信息（名称、概括、来源链接）
3. 存储到 memes.json
"""
import json
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Optional

from config import MEMES_DATA_FILE, MEME_SEPARATOR, IMAGE_ASSOCIATE_WINDOW_MINUTES


class MemeRecord:
    """单条热梗记录"""
    
    def __init__(self, name: str, summary: str, source_url: str = "",
                 contributor: str = "", image_path: str = ""):
        self.id = str(uuid.uuid4())[:8]
        self.name = name.strip()
        self.summary = summary.strip()
        self.source_url = source_url.strip()
        self.contributor = contributor
        self.image_path = image_path
        self.created_at = datetime.now().isoformat()
        self.week_number = datetime.now().isocalendar()[1]
        self.year = datetime.now().year

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "summary": self.summary,
            "source_url": self.source_url,
            "contributor": self.contributor,
            "image_path": self.image_path,
            "created_at": self.created_at,
            "week_number": self.week_number,
            "year": self.year,
        }


class MessageHandler:
    """处理企微消息，提取并存储热梗"""

    def __init__(self):
        self.data_file = MEMES_DATA_FILE
        self._ensure_data_file()

    def _ensure_data_file(self):
        """确保数据文件存在"""
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        if not self.data_file.exists():
            self.data_file.write_text("[]", encoding="utf-8")

    def parse_xml_message(self, xml_content: str) -> dict:
        """
        解析企微推送的 XML 消息
        
        Returns:
            dict: {
                "msg_type": "text" | "image" | ...,
                "from_user": 发送者ID,
                "content": 消息内容,
                "chat_type": "group" | "single",
                "msg_id": 消息ID,
                "chat_id": 群聊ID(如果是群聊),
                "pic_url": 图片URL(如果是图片消息),
            }
        """
        root = ET.fromstring(xml_content)
        
        msg_type = root.findtext("MsgType", "")
        result = {
            "msg_type": msg_type,
            "from_user": root.findtext("From/UserId", ""),
            "chat_type": "group" if root.find("ChatId") is not None else "single",
            "msg_id": root.findtext("MsgId", ""),
            "chat_id": root.findtext("ChatId", ""),
        }

        if msg_type == "text":
            result["content"] = root.findtext("Text/Content", "").strip()
        elif msg_type == "image":
            result["pic_url"] = root.findtext("Image/ImageUrl", "")
            result["media_id"] = root.findtext("Image/MediaId", "")

        return result

    def handle_group_text(self, message: dict) -> Optional[str]:
        """
        处理群聊文本消息（@机器人 发的热梗）
        
        消息格式：梗名称 | 一句话概括 | 来源链接
        或简化格式：梗名称 | 一句话概括
        
        Returns:
            回复消息（字符串），None 表示不回复
        """
        content = message.get("content", "")
        contributor = message.get("from_user", "")

        # 去掉可能的 @机器人 前缀
        # 企微推送时可能已经去掉了 @部分，保险起见处理一下
        content = content.strip()

        if not content:
            return None

        # 按分隔符拆分
        parts = content.split(MEME_SEPARATOR)
        
        if len(parts) < 2:
            return ("📝 格式提示：\n"
                    "梗名称 | 一句话概括 | 来源链接\n"
                    "例如：城市不会眨眼 | 短视频魔性台词配合面无表情表演 | https://v.douyin.com/xxx")

        name = parts[0].strip()
        summary = parts[1].strip()
        source_url = parts[2].strip() if len(parts) > 2 else ""

        # 创建记录
        meme = MemeRecord(
            name=name,
            summary=summary,
            source_url=source_url,
            contributor=contributor,
        )
        
        self._save_meme(meme)

        return f"✅ 已记录热梗：{name}\n📌 {summary}" + (f"\n🔗 {source_url}" if source_url else "")

    def handle_private_image(self, message: dict, image_path: str) -> Optional[str]:
        """
        处理私聊图片消息，关联到最近一条热梗
        
        Args:
            message: 解析后的消息字典
            image_path: 已下载图片的本地路径
        
        Returns:
            回复消息
        """
        contributor = message.get("from_user", "")
        memes = self._load_memes()

        # 找到该用户最近一条没有图片的热梗（在关联窗口内）
        now = datetime.now()
        target_meme = None
        
        for meme in reversed(memes):
            if meme["contributor"] != contributor:
                continue
            if meme["image_path"]:
                continue
            
            created = datetime.fromisoformat(meme["created_at"])
            diff_minutes = (now - created).total_seconds() / 60
            
            if diff_minutes <= IMAGE_ASSOCIATE_WINDOW_MINUTES:
                target_meme = meme
                break

        if target_meme:
            target_meme["image_path"] = image_path
            self._save_all_memes(memes)
            return f"🖼️ 截图已关联到热梗：{target_meme['name']}"
        else:
            return ("⚠️ 未找到可关联的热梗记录。\n"
                    f"请先在群聊中 @机器人 录入热梗（{IMAGE_ASSOCIATE_WINDOW_MINUTES}分钟内），"
                    "然后再发截图。")

    def _save_meme(self, meme: MemeRecord):
        """追加保存一条热梗"""
        memes = self._load_memes()
        memes.append(meme.to_dict())
        self._save_all_memes(memes)

    def _load_memes(self) -> list:
        """加载所有热梗数据"""
        try:
            content = self.data_file.read_text(encoding="utf-8")
            return json.loads(content)
        except (json.JSONDecodeError, FileNotFoundError):
            return []

    def _save_all_memes(self, memes: list):
        """覆盖保存所有热梗数据"""
        self.data_file.write_text(
            json.dumps(memes, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    def get_memes_for_week(self, year: int = None, week: int = None) -> list:
        """获取指定周的热梗数据"""
        if year is None:
            year = datetime.now().year
        if week is None:
            week = datetime.now().isocalendar()[1]

        memes = self._load_memes()
        return [m for m in memes if m["year"] == year and m["week_number"] == week]

    def get_recent_memes(self, count: int = 20) -> list:
        """获取最近 N 条热梗"""
        memes = self._load_memes()
        return memes[-count:]
