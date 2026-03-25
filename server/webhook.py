"""
企微群 Webhook 推送模块

通过 Webhook 往企微群里发确认消息。
群机器人 Webhook 不需要管理员权限，群里任何人都可以添加。
"""
import requests
from config import WEBHOOK_URL


def send_webhook_notification(meme_name: str, meme_summary: str,
                               contributor: str, has_image: bool = False) -> bool:
    """
    向企微群发送热梗录入通知

    Args:
        meme_name: 热梗名称
        meme_summary: 一句话概括
        contributor: 贡献者名称
        has_image: 是否附带截图

    Returns:
        是否发送成功
    """
    if not WEBHOOK_URL:
        print("[Webhook] 未配置 WEBHOOK_URL，跳过群通知")
        return False

    image_tag = " 🖼️" if has_image else ""
    content = (
        f"🔥 **新热梗录入{image_tag}**\n"
        f"> 梗名：**{meme_name}**\n"
        f"> 概括：{meme_summary}\n"
        f"> 贡献者：{contributor}"
    )

    payload = {
        "msgtype": "markdown",
        "markdown": {
            "content": content
        }
    }

    try:
        resp = requests.post(WEBHOOK_URL, json=payload, timeout=5)
        result = resp.json()
        if result.get("errcode") == 0:
            print(f"[Webhook] 通知发送成功: {meme_name}")
            return True
        else:
            print(f"[Webhook] 发送失败: {result}")
            return False
    except Exception as e:
        print(f"[Webhook] 请求异常: {e}")
        return False


def send_weekly_report_notification(year: int, week: int, total: int,
                                     report_url: str = "") -> bool:
    """
    向群里发送周报生成通知

    Args:
        year: 年份
        week: 周数
        total: 热梗总数
        report_url: 周报在线链接（可选）
    """
    if not WEBHOOK_URL:
        return False

    content = (
        f"📊 **热梗周报已生成**\n"
        f"> {year} 年第 {week} 周\n"
        f"> 本周共收录 **{total}** 个热梗\n"
    )
    if report_url:
        content += f"> [👉 查看周报]({report_url})"

    payload = {
        "msgtype": "markdown",
        "markdown": {
            "content": content
        }
    }

    try:
        resp = requests.post(WEBHOOK_URL, json=payload, timeout=5)
        return resp.json().get("errcode") == 0
    except Exception:
        return False
