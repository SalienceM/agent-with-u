---
name: football-search
description: 搜索天下足球网的足球视频资源（比赛录像、集锦、直播）。当用户需要查找足球视频、比赛录像或相关资源时使用。
type: python-script
input_schema:
  type: object
  properties:
    query:
      type: string
      description: 搜索关键词，例如球队名、赛事名、球员名
    category:
      type: string
      description: 资源分类，可选值：replay（录像）、highlight（集锦）、live（直播），不填则全部搜索
    limit:
      type: integer
      description: 最多返回条数，默认 10，最大 50
  required:
    - query
---

## Instructions

当用户提到想看足球视频、比赛录像、集锦，或询问"天下足球"相关内容时，调用此 Skill。

调用前：
1. 从用户消息中提取搜索关键词（球队、赛事、球员名等）
2. 判断用户想要的资源类型（录像/集锦/直播/全部）
3. 调用 Skill 获取搜索结果列表
4. 以清晰的格式展示结果，包含标题、时间、链接

## Example Usage

- "帮我找一下皇马对巴萨的录像"
- "天下足球有英超最新一轮的视频吗"
- "搜一下梅西的进球集锦"
- "找找欧冠决赛的回放"
