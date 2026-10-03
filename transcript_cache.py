"""Bounded persistent transcripts and single-process asynchronous request sharing."""
import asyncio
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
import time
from contextlib import contextmanager


def valid_transcript(value):
    return (isinstance(value, dict) and isinstance(value.get('transcription'), list)
            and all(isinstance(s, dict) and isinstance(s.get('text'), str)
                    for s in value['transcription'])
            and any(s['text'].strip() for s in value['transcription']))


def config_version(model_path, revision='1'):
    return hashlib.sha256(json.dumps([str(Path(model_path).resolve()),
                                    {'beam_size': 5}, str(revision)]).encode()).hexdigest()


class TranscriptCache:
    def __init__(self, path, *, enabled=True, ttl_days=7, max_entries=500, logger=None):
        self.path = Path(path)
        self.enabled = enabled
        self.ttl = float(ttl_days) * 86400
        self.max_entries = int(max_entries)
        self.logger = logger or logging.getLogger(__name__)

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute('CREATE TABLE IF NOT EXISTS transcripts '
                       '(key TEXT PRIMARY KEY, body TEXT NOT NULL, created REAL, used REAL)')
            with db:
                yield db
        finally:
            db.close()

    def get(self, key):
        if not self.enabled:
            return None
        try:
            with self.connect() as db:
                db.execute('DELETE FROM transcripts WHERE created <= ?', (time.time() - self.ttl,))
                row = db.execute('SELECT body FROM transcripts WHERE key = ?', (key,)).fetchone()
                if row:
                    body = json.loads(row[0])
                    if valid_transcript(body):
                        db.execute('UPDATE transcripts SET used = ? WHERE key = ?', (time.time(), key))
                        return body
                    db.execute('DELETE FROM transcripts WHERE key = ?', (key,))
        except Exception:
            self.logger.warning('转录缓存读取失败，继续正常转录', exc_info=True)
        return None

    def put(self, key, body):
        if not self.enabled or not valid_transcript(body):
            return
        try:
            with self.connect() as db:
                now = time.time()
                db.execute('INSERT OR REPLACE INTO transcripts VALUES (?, ?, ?, ?)',
                           (key, json.dumps(body, ensure_ascii=False), now, now))
                db.execute('DELETE FROM transcripts WHERE created <= ?', (now - self.ttl,))
                db.execute('DELETE FROM transcripts WHERE key IN '
                           '(SELECT key FROM transcripts ORDER BY used DESC, key LIMIT -1 OFFSET ?)',
                           (max(0, self.max_entries),))
        except Exception:
            self.logger.warning('转录缓存写入失败，继续返回转录结果', exc_info=True)


class TranscriptionService:
    def __init__(self, cache, version):
        self.cache = cache
        self.version = version
        self.inflight = {}

    async def run(self, url, kind, worker, *, force_refresh=False):
        key = hashlib.sha256(json.dumps([url, kind, self.version]).encode()).hexdigest()
        # Check in-flight before disk so a refresh cannot be overtaken by old data.
        if key in self.inflight:
            task, refreshing = self.inflight[key]
            response = await asyncio.shield(task)
            if not force_refresh or refreshing:
                return response
            return await self.run(url, kind, worker, force_refresh=True)
        task = asyncio.create_task(self._resolve(key, worker, force_refresh))
        self.inflight[key] = (task, force_refresh)
        def finished(completed):
            self.inflight.pop(key, None)
            if not completed.cancelled():
                completed.exception()  # Consume failures even if every waiter disconnects.
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def _resolve(self, key, worker, refresh):
        from starlette.responses import JSONResponse
        body = None if refresh else await asyncio.to_thread(self.cache.get, key)
        if body is not None:
            self.cache.logger.info('使用后端转录缓存 %s', key[:12])
            return JSONResponse(content=body, headers={'X-Transcript-Cache': 'hit'})
        self.cache.logger.info('转录缓存%s %s', '强制刷新' if refresh else '未命中', key[:12])
        response = await asyncio.to_thread(worker)
        if response.status_code == 200:
            try:
                await asyncio.to_thread(self.cache.put, key, json.loads(response.body))
            except (ValueError, TypeError):
                pass
        response.headers['X-Transcript-Cache'] = 'refresh' if refresh else 'miss'
        return response
