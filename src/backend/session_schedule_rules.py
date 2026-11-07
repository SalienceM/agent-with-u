"""定时指令的纯时间计算；预览、保存与执行端消费使用同一规则。"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import math
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc
GRACE_SECONDS = 60
MAX_TIMESTAMP = datetime(2100, 1, 1, tzinfo=UTC).timestamp()


class ScheduleError(ValueError):
    pass


def timestamp(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ScheduleError('时间必须是有效时间戳')
    if not 0 < value < MAX_TIMESTAMP:
        raise ScheduleError('时间须位于 1970 至 2100 年之间')
    return float(value)


def zone(name: Any) -> ZoneInfo:
    if not isinstance(name, str) or not name or len(name) > 100:
        raise ScheduleError('请选择 IANA 时区')
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ScheduleError('执行节点缺少该时区数据，不能回退本机时区') from exc


def local_candidates(local: datetime, tz: ZoneInfo) -> list[float]:
    """用 UTC 往返拒绝 gap；fold 两个候选去重后按先后排序。"""
    values = set()
    for fold in (0, 1):
        aware = local.replace(tzinfo=tz, fold=fold)
        instant = aware.timestamp()
        if datetime.fromtimestamp(instant, tz).replace(tzinfo=None) == local:
            values.add(instant)
    return sorted(values)


def normalize_config(value: Any, now: float, *, future: bool = True) -> dict:
    if not isinstance(value, dict):
        raise ScheduleError('定时配置无效')
    title, prompt = value.get('title'), value.get('prompt')
    if not isinstance(title, str) or not title.strip() or len(title) > 120:
        raise ScheduleError('名称须为 1–120 字符')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 64000:
        raise ScheduleError('预设指令须为 1–64000 字符')
    tz = zone(value.get('timezone'))
    policy = value.get('misfirePolicy', 'catch_up_once')
    if policy not in {'catch_up_once', 'skip'} or type(value.get('enabled', False)) is not bool:
        raise ScheduleError('启用状态或错过策略无效')
    raw = value.get('rule')
    if not isinstance(raw, dict):
        raise ScheduleError('时间规则无效')
    kind = raw.get('kind')
    rule: dict = {'kind': kind}
    if kind == 'once':
        at = raw.get('at')
        if isinstance(at, str):
            try:
                local = datetime.fromisoformat(at)
            except ValueError as exc:
                raise ScheduleError('单次时间格式无效') from exc
            if local.tzinfo is not None:
                raise ScheduleError('请使用当地时间，并用 offsetMinutes 明确时差')
            choices = local_candidates(local, tz)
            offset = raw.get('offsetMinutes')
            if offset is not None:
                if type(offset) is not int:
                    raise ScheduleError('UTC 时差无效')
                choices = [v for v in choices if datetime.fromtimestamp(v, tz).utcoffset().total_seconds() == offset * 60]
            if not choices:
                raise ScheduleError('该当地时间不存在，或所选 UTC 时差不匹配')
            if len(choices) > 1:
                offsets = [int(datetime.fromtimestamp(v, tz).utcoffset().total_seconds() / 60) for v in choices]
                raise ScheduleError(f'该时间重复，请指定 offsetMinutes：{offsets}')
            at = choices[0]
        rule['at'] = timestamp(at)
        if future and rule['at'] <= now:
            raise ScheduleError('单次时间已过期，请选择未来时间')
    elif kind == 'interval':
        seconds = raw.get('seconds')
        if type(seconds) is not int or not 60 <= seconds <= 366 * 86400:
            raise ScheduleError('固定间隔须为一分钟至 366 天的整数秒')
        rule.update(seconds=seconds, anchor=timestamp(raw.get('anchor')))
    elif kind in {'daily', 'weekly'}:
        clock = raw.get('time')
        try:
            parsed = time.fromisoformat(clock) if isinstance(clock, str) else None
        except ValueError:
            parsed = None
        if parsed is None or parsed.tzinfo or parsed.second or parsed.microsecond:
            raise ScheduleError('每天/每周时间须为 HH:mm')
        rule['time'] = parsed.strftime('%H:%M')
        if kind == 'weekly':
            days = raw.get('weekdays')
            if not isinstance(days, list) or not days or any(type(d) is not int or not 0 <= d <= 6 for d in days):
                raise ScheduleError('请至少选择一个星期，0 为星期一')
            rule['weekdays'] = sorted(set(days))
    else:
        raise ScheduleError('不支持的时间规则')
    return {'version': 1, 'title': title.strip(), 'prompt': prompt.strip(), 'timezone': tz.key,
            'rule': rule, 'misfirePolicy': policy, 'enabled': value.get('enabled', False)}


def day_instant(rule: dict, day: date, tz: ZoneInfo) -> float | None:
    if rule['kind'] == 'weekly' and day.weekday() not in rule['weekdays']:
        return None
    values = local_candidates(datetime.combine(day, time.fromisoformat(rule['time'])), tz)
    return values[0] if values else None


def next_due(config: dict, after: float) -> float | None:
    rule = config['rule']
    if rule['kind'] == 'once':
        return rule['at'] if rule['at'] > after else None
    if rule['kind'] == 'interval':
        anchor, seconds = rule['anchor'], rule['seconds']
        result = anchor + max(0, math.floor((after - anchor) / seconds) + 1) * seconds
        return result if result < MAX_TIMESTAMP else None
    tz = zone(config['timezone'])
    start = datetime.fromtimestamp(after, tz).date()
    # 最多两周即可跨过周规则及一次 DST gap，不扫描历史分钟。
    for offset in range(15):
        result = day_instant(rule, start + timedelta(days=offset), tz)
        if result is not None and after < result < MAX_TIMESTAMP:
            return result
    return None


def due_range(config: dict, first: float, until: float) -> tuple[int, float]:
    """从已经保存的 nextDueAt 计算消费范围；区间规则 O(1)，日历逐日有界。"""
    if first > until:
        return 0, first
    rule = config['rule']
    if rule['kind'] == 'once':
        return 1, first
    if rule['kind'] == 'interval':
        count = math.floor((until - first) / rule['seconds']) + 1
        return count, first + (count - 1) * rule['seconds']
    tz = zone(config['timezone'])
    start = datetime.fromtimestamp(first, tz).date()
    end = datetime.fromtimestamp(min(until, MAX_TIMESTAMP - 1), tz).date()
    count, last = 0, first
    for offset in range((end - start).days + 1):
        current = day_instant(rule, start + timedelta(days=offset), tz)
        if current is not None and first <= current <= until:
            count, last = count + 1, current
    return count, last


def preview(config: dict, now: float) -> dict:
    due = next_due(config, now)
    return {'nextDueAt': due, 'localTime': datetime.fromtimestamp(due, zone(config['timezone'])).isoformat() if due else None,
            'timezone': config['timezone'], 'dstPolicy': '不存在的当地时刻跳过；重复时刻只执行较早的一次'}


def normalize_schedule_ref(value: Any) -> dict | None:
    if not isinstance(value, dict):
        return None
    result = {key: value[key] for key in ('scheduleId', 'occurrenceId')
              if isinstance(value.get(key), str) and 0 < len(value[key]) <= 160}
    if len(result) != 2 or type(value.get('scheduleRevision')) is not int:
        return None
    result['scheduleRevision'] = value['scheduleRevision']
    try:
        result['scheduledAt'] = timestamp(value.get('scheduledAt'))
    except ScheduleError:
        return None
    return result
