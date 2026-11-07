"""有界重试和断点续传；部分文件不是验收，交付前仍核对整个 SHA-256。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import time
from typing import Any, Callable

import httpx

RETRY_DELAYS = (1, 2, 4)


class DownloadInterrupted(RuntimeError):
    pass


async def _disk(function: Callable[..., Any], *args: Any) -> Any:
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()
        raise


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


async def download_http(url: str, partial: Path, expected_hash: str, expected_size: int,
                        headers: dict[str, str], limit: int,
                        progress: Callable[[dict[str, Any]], Any]) -> tuple[int, str]:
    identity = hashlib.sha256(json.dumps([url, expected_hash, expected_size]).encode()).hexdigest()
    metadata = partial.with_suffix(partial.suffix + '.json')
    def prepare() -> None:
        try:
            previous = json.loads(metadata.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            previous = {}
        if previous.get('identity') != identity:
            partial.unlink(missing_ok=True)
        temporary = metadata.with_suffix('.tmp')
        temporary.write_text(json.dumps({'identity': identity}), encoding='utf-8')
        os.replace(temporary, metadata)
    await _disk(prepare)
    for attempt in range(len(RETRY_DELAYS) + 1):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > limit or expected_size and offset > expected_size:
            partial.unlink(missing_ok=True)
            offset = 0
        if expected_size and offset == expected_size:
            digest = await _disk(_hash, partial)
            if digest == expected_hash:
                return offset, digest
            partial.unlink(missing_ok=True)
            offset = 0
        request_headers = {key: value for key, value in headers.items()
                           if key.lower() not in {'range', 'if-range', 'accept-encoding'}}
        request_headers['Accept-Encoding'] = 'identity'
        if offset:
            request_headers['Range'] = f'bytes={offset}-'
        progress({'phase': 'downloading', 'message': '正在断点续传' if offset else '正在下载更新',
                  'downloadedBytes': offset, 'resumedBytes': offset, 'retryAttempt': attempt, 'retryInSeconds': 0})
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, connect=10, read=30)) as client:
                async with client.stream('GET', url, headers=request_headers) as response:
                    if response.status_code == 416 and offset:
                        partial.unlink(missing_ok=True)
                        raise DownloadInterrupted('服务器断点已失效，将重新下载')
                    response.raise_for_status()
                    if response.headers.get('content-encoding', 'identity').lower() not in {'identity', ''}:
                        raise ValueError('下载响应使用了不支持的压缩编码')
                    total = expected_size
                    range_end = None
                    if response.status_code == 206:
                        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('content-range', ''))
                        if not match:
                            raise ValueError('下载响应缺少有效 Content-Range')
                        start, range_end, total = map(int, match.groups())
                        if start != offset or range_end < start or range_end >= total or (expected_size and total != expected_size):
                            raise ValueError('下载断点或制品大小与冻结计划不一致')
                    elif response.status_code == 200:
                        offset = 0  # CDN 不支持 Range 时使用同一响应完整重下，绝不追加整包。
                        progress({'resumedBytes': 0, 'downloadedBytes': 0})
                        total = expected_size or int(response.headers.get('content-length') or 0)
                    else:
                        raise ValueError('更新服务器返回了非文件响应')
                    if total > limit:
                        raise ValueError('更新制品超过大小限制')
                    downloaded, last = offset, 0.0
                    with partial.open('ab' if offset else 'wb') as stream:
                        async for block in response.aiter_bytes(64 * 1024):
                            downloaded += len(block)
                            if downloaded > limit or total and downloaded > total or range_end is not None and downloaded > range_end + 1:
                                raise ValueError('更新下载内容超过声明大小')
                            await _disk(stream.write, block)
                            if time.monotonic() - last >= .5:
                                progress({'phase': 'downloading', 'downloadedBytes': downloaded, 'totalBytes': total})
                                last = time.monotonic()
                    if total and downloaded < total:
                        raise DownloadInterrupted('连接提前结束，保留断点')
            return downloaded, await _disk(_hash, partial)
        except (httpx.TransportError, httpx.HTTPStatusError, DownloadInterrupted) as error:
            if isinstance(error, httpx.HTTPStatusError) and error.response.status_code not in {408, 429, 500, 502, 503, 504}:
                raise
            if attempt >= len(RETRY_DELAYS):
                raise DownloadInterrupted('网络仍不可用，已保留下载断点；恢复连接后可再次更新。') from error
            delay = RETRY_DELAYS[attempt]
            progress({'phase': 'downloading', 'message': f'网络中断，{delay} 秒后继续下载',
                      'retryAttempt': attempt + 1, 'retryInSeconds': delay})
            await asyncio.sleep(delay)
    raise DownloadInterrupted('下载未完成')
