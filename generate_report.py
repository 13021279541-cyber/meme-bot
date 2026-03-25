"""
热梗周报生成器

读取 data/memes.json，生成 16:9 HTML 周报到 output/ 目录。

用法：
    python generate_report.py              # 生成本周周报
    python generate_report.py --week 12    # 生成第12周周报
    python generate_report.py --demo       # 使用演示数据生成
"""
import argparse
import json
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

# 项目根目录
PROJECT_ROOT = Path(__file__).parent

# 配置
MEMES_DATA_FILE = PROJECT_ROOT / "data" / "memes.json"
TEMPLATES_DIR = PROJECT_ROOT / "templates"
OUTPUT_DIR = PROJECT_ROOT / "output"
MEMES_PER_PAGE = 4  # 每页展示的梗数量（4列一行）


def load_memes(year: int = None, week: int = None) -> list:
    """加载指定周的热梗数据"""
    if not MEMES_DATA_FILE.exists():
        return []
    
    content = MEMES_DATA_FILE.read_text(encoding="utf-8")
    all_memes = json.loads(content)

    if year is None:
        year = datetime.now().year
    if week is None:
        week = datetime.now().isocalendar()[1]

    return [m for m in all_memes if m.get("year") == year and m.get("week_number") == week]


def get_demo_memes() -> list:
    """生成演示数据"""
    now = datetime.now()
    demo_data = [
        {
            "id": "demo001",
            "name": "城市不会眨眼",
            "summary": "来自某短视频的魔性台词。主角面无表情直视镜头，配合诡异 BGM，迅速成为各大平台的模仿热梗。适合用在甲方审稿、需求变更等'面无表情但内心崩溃'的场景。",
            "source_url": "https://v.douyin.com/example1",
            "contributor": "xiaoming",
            "image_path": "",
            "created_at": now.isoformat(),
            "week_number": now.isocalendar()[1],
            "year": now.year,
        },
        {
            "id": "demo002",
            "name": "我在人间贴瓷砖",
            "summary": "形容自己在做一些毫无意义但又不得不做的重复性劳动。起源于某位装修工人的自嘲短视频，后被打工人广泛引用，特别适合描述写周报、填表格等工作。",
            "source_url": "https://v.douyin.com/example2",
            "contributor": "xiaohua",
            "image_path": "",
            "created_at": (now - timedelta(days=1)).isoformat(),
            "week_number": now.isocalendar()[1],
            "year": now.year,
        },
        {
            "id": "demo003",
            "name": "命运的齿轮开始转动",
            "summary": "用来标记人生中某个看似不起眼但实际影响深远的时刻。通常配合一段回忆叙事使用，先描述一个普通事件，然后加上'从那一刻起，命运的齿轮开始转动'。",
            "source_url": "https://v.douyin.com/example3",
            "contributor": "zhangsan",
            "image_path": "",
            "created_at": (now - timedelta(days=2)).isoformat(),
            "week_number": now.isocalendar()[1],
            "year": now.year,
        },
        {
            "id": "demo004",
            "name": "泼天的富贵",
            "summary": "指突然降临的巨大好运或流量。常见句式：'泼天的富贵终于轮到XX了'。最初用于形容某些品牌突然爆火，后泛化为各种意外走运的情况。",
            "source_url": "",
            "contributor": "lisi",
            "image_path": "",
            "created_at": (now - timedelta(days=3)).isoformat(),
            "week_number": now.isocalendar()[1],
            "year": now.year,
        },
        {
            "id": "demo005",
            "name": "遥遥领先",
            "summary": "起源于某科技发布会的高频用词，后成为万能夸赞/调侃用语。不管是吃了一碗好面还是加了一个好班，都可以说'遥遥领先'。反讽意味和正面使用并存。",
            "source_url": "https://v.douyin.com/example5",
            "contributor": "xiaoming",
            "image_path": "",
            "created_at": (now - timedelta(days=4)).isoformat(),
            "week_number": now.isocalendar()[1],
            "year": now.year,
        },
        {
            "id": "demo006",
            "name": "挖呀挖呀挖",
            "summary": "一首幼儿园老师教的儿歌意外走红全网。旋律洗脑、歌词简单重复，迅速催生各种改编版本。现在泛指任何魔性循环的事物，或用于描述枯燥重复的工作状态。",
            "source_url": "",
            "contributor": "xiaohua",
            "image_path": "",
            "created_at": (now - timedelta(days=5)).isoformat(),
            "week_number": now.isocalendar()[1],
            "year": now.year,
        },
    ]
    return demo_data


def get_week_date_range(year: int, week: int) -> str:
    """获取某一周的日期范围字符串"""
    # ISO 周一为一周第一天
    jan4 = datetime(year, 1, 4)
    start = jan4 + timedelta(weeks=week - 1, days=-jan4.weekday())
    end = start + timedelta(days=6)
    return f"{start.year}年 {start.month}月{start.day}日 ~ {end.month}月{end.day}日"


# 无图卡片的随机装饰 emoji
PLACEHOLDER_EMOJIS = ["🔥", "💀", "😂", "🤡", "👀", "💅", "🐶", "🌶️", "⚡", "🎭", "🤯", "😎"]


def format_meme_for_display(meme: dict, index: int) -> dict:
    """为模板渲染准备梗数据"""
    created = datetime.fromisoformat(meme["created_at"])
    
    # 图片路径：支持完整 URL (Supabase) 和本地相对路径
    image_path = meme.get("image_path", "")
    if image_path and not image_path.startswith("http"):
        # 本地路径：转为相对于输出目录的路径
        image_path = f"../{image_path}"
    # 如果是 http 开头的完整 URL，直接使用
    
    return {
        "global_index": index + 1,
        "name": meme["name"],
        "summary": meme["summary"],
        "source_url": meme.get("source_url", ""),
        "contributor_name": meme.get("contributor", "匿名"),
        "image_path": image_path,
        "emoji": random.choice(PLACEHOLDER_EMOJIS),
        "date_display": f"{created.month}/{created.day}",
        "category": meme.get("category", ""),
        "priority": meme.get("priority", ""),
    }


def paginate_memes(memes: list) -> list:
    """将梗列表分页，每页最多 MEMES_PER_PAGE 个"""
    pages = []
    for i in range(0, len(memes), MEMES_PER_PAGE):
        pages.append(memes[i:i + MEMES_PER_PAGE])
    return pages


def build_word_cloud(memes: list) -> list:
    """
    为封面页生成词云数据。
    
    每个词有 name 和 size (1-5，1最大)。
    前 1/5 的梗用 size 1，接着 1/5 用 size 2，以此类推。
    列表会被随机打乱，让词云看起来不是按大小排序的。
    """
    names = [m["name"] for m in memes]
    total = len(names)
    
    if total == 0:
        return []
    
    items = []
    for i, name in enumerate(names):
        # 按位置分配大小等级：靠前的梗字号更大
        ratio = i / total
        if ratio < 0.2:
            size = 1
        elif ratio < 0.4:
            size = 2
        elif ratio < 0.6:
            size = 3
        elif ratio < 0.8:
            size = 4
        else:
            size = 5
        items.append({"name": name, "size": size})
    
    random.shuffle(items)
    return items


def generate_report(memes: list, year: int, week: int) -> str:
    """
    生成 HTML 周报
    
    Returns:
        输出文件路径
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 准备模板数据
    formatted = [format_meme_for_display(m, i) for i, m in enumerate(memes)]
    pages = paginate_memes(formatted)
    
    word_cloud_items = build_word_cloud(memes)

    template_data = {
        "year": year,
        "week_number": week,
        "date_range": get_week_date_range(year, week),
        "total_memes": len(memes),
        "pages": pages,
        "word_cloud_items": word_cloud_items,
    }

    # 渲染模板
    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)))
    template = env.get_template("weekly_report.html")
    html_content = template.render(**template_data)

    # 输出文件
    output_file = OUTPUT_DIR / f"热梗周报_{year}_W{week:02d}.html"
    output_file.write_text(html_content, encoding="utf-8")
    
    print(f"✅ 周报已生成: {output_file}")
    print(f"   共 {len(memes)} 个热梗, {len(pages)} 页内容")
    
    return str(output_file)


def generate_report_by_date_range(memes: list, start_date: str, end_date: str) -> str:
    """
    按日期范围生成 HTML 周报（用于前端 Tab 调用）

    Args:
        memes: 已过滤、已排序的热梗列表
        start_date: 开始日期 YYYY-MM-DD
        end_date: 结束日期 YYYY-MM-DD

    Returns:
        输出文件路径
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 准备模板数据
    formatted = [format_meme_for_display(m, i) for i, m in enumerate(memes)]
    pages = paginate_memes(formatted)

    word_cloud_items = build_word_cloud(memes)

    # 日期范围显示
    s = datetime.strptime(start_date, "%Y-%m-%d")
    e = datetime.strptime(end_date, "%Y-%m-%d")
    date_range = f"{s.year}年 {s.month}月{s.day}日 ~ {e.month}月{e.day}日"

    template_data = {
        "year": s.year,
        "week_number": s.isocalendar()[1],
        "date_range": date_range,
        "total_memes": len(memes),
        "pages": pages,
        "word_cloud_items": word_cloud_items,
    }

    # 渲染模板
    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)))
    template = env.get_template("weekly_report.html")
    html_content = template.render(**template_data)

    # 输出文件
    output_file = OUTPUT_DIR / f"热梗周报_{start_date}_to_{end_date}.html"
    output_file.write_text(html_content, encoding="utf-8")

    print(f"✅ 周报已生成: {output_file}")
    print(f"   共 {len(memes)} 个热梗, {len(pages)} 页内容")

    return str(output_file)


def main():
    parser = argparse.ArgumentParser(description="热梗周报生成器")
    parser.add_argument("--year", type=int, default=None, help="年份")
    parser.add_argument("--week", type=int, default=None, help="周数")
    parser.add_argument("--demo", action="store_true", help="使用演示数据")
    args = parser.parse_args()

    now = datetime.now()
    year = args.year or now.year
    week = args.week or now.isocalendar()[1]

    if args.demo:
        print("📝 使用演示数据生成周报...")
        memes = get_demo_memes()
    else:
        print(f"📂 加载 {year} 年第 {week} 周的热梗数据...")
        memes = load_memes(year, week)

    if not memes:
        print("😅 没有找到热梗数据。使用 --demo 参数可以生成演示周报。")
        sys.exit(0)

    output_path = generate_report(memes, year, week)
    print(f"\n🎉 完成！用浏览器打开查看：\n   {output_path}")


if __name__ == "__main__":
    main()
