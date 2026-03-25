# 🔥 热梗自动化周报系统

基于企业微信智能机器人，自动收集团队分享的热梗，每周生成 16:9 精美 HTML 周报。

## 🏗️ 架构

```
【录入端】                          【处理端】                    【输出端】

企业微信群                          回调服务(Flask)              周报生成器
@热梗机器人 发文字  ──→  接收消息 ──→ 解析存储 ──→ memes.json
                                                                    ↓
私聊机器人 发截图   ──→  接收图片 ──→ 下载保存 ──→ images/     ──→ HTML周报
                                      关联记录                   (16:9 卡片布局)
```

## 📁 项目结构

```
热梗自动化/
├── server/
│   ├── config.py          # 配置文件（企微Token等）
│   ├── app.py             # Flask 回调服务主入口
│   ├── crypto.py          # 企微消息加解密
│   ├── message_handler.py # 消息解析和处理
│   └── image_handler.py   # 图片下载和关联
├── data/
│   └── memes.json         # 热梗数据存储
├── images/                # 截图存储目录
├── templates/
│   └── weekly_report.html # 周报 HTML 模板
├── output/                # 生成的周报文件
├── generate_report.py     # 周报生成脚本
└── requirements.txt
```

## 🚀 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置企业微信

参见 [企业微信配置指南](./SETUP_GUIDE.md)

### 3. 启动回调服务

```bash
python server/app.py
```

### 4. 生成周报

```bash
python generate_report.py
```

## 📝 使用方式

### 群聊录入热梗
在企业微信群里 @热梗机器人，格式：
```
@热梗机器人 梗名称 | 一句话概括 | 来源链接
```

示例：
```
@热梗机器人 城市不会眨眼 | 来自某短视频的魔性台词，配合面无表情的表演 | https://v.douyin.com/xxx
```

### 私聊发截图
直接私聊机器人发送图片，机器人会自动关联到最近一条热梗记录。

### 生成周报
运行 `python generate_report.py` 或等待 WorkBuddy 定时任务自动生成。
