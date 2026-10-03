import asyncio
import ast
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from starlette.responses import JSONResponse
from transcript_cache import TranscriptCache, TranscriptionService, config_version

BODY = {'language': 'en', 'language_probability': 1,
        'transcription': [{'start': 0, 'end': 1, 'text': 'hello'}]}


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'cache.sqlite3'
        self.cache = TranscriptCache(self.path, max_entries=2)

    def tearDown(self):
        self.directory.cleanup()

    def test_persistence_expiry_and_lru(self):
        with patch('transcript_cache.time.time', return_value=100):
            self.cache.put('a', BODY)
        with patch('transcript_cache.time.time', return_value=101):
            self.cache.put('b', BODY)
        with patch('transcript_cache.time.time', return_value=102):
            self.assertEqual(TranscriptCache(self.path).get('a'), BODY)
        with patch('transcript_cache.time.time', return_value=103):
            self.cache.put('c', BODY)
            self.assertIsNone(self.cache.get('b'))
            self.assertEqual(self.cache.get('a'), BODY)
        with patch('transcript_cache.time.time', return_value=103 + 7 * 86400):
            self.assertIsNone(self.cache.get('a'))
            self.assertIsNone(self.cache.get('c'))

    def test_empty_invalid_disabled_and_corruption(self):
        for body in ({}, {'transcription': []}, {'transcription': [{'text': ' '}]},
                     {'transcription': [{'text': 1}]}, {'transcription': [None]}):
            self.cache.put('a', body)
            self.assertIsNone(self.cache.get('a'))
        self.cache.enabled = False
        self.path.unlink()
        self.cache.put('a', BODY)
        self.assertFalse(self.path.exists())
        self.cache.enabled = True
        self.path.write_bytes(b'broken database')
        self.assertIsNone(self.cache.get('a'))
        self.cache.put('a', BODY)  # No error propagated to the request.

    def test_version_changes(self):
        self.assertNotEqual(config_version('./base'), config_version('./other'))
        self.assertNotEqual(config_version('./base', '1'), config_version('./base', '2'))


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cache = TranscriptCache(Path(self.directory.name) / 'cache.sqlite3')
        self.service = TranscriptionService(self.cache, 'v1')
        self.calls = 0

    async def asyncTearDown(self):
        self.directory.cleanup()

    def worker(self):
        self.calls += 1
        return JSONResponse(BODY)

    async def run_media(self, url='a', kind='audio', **kwargs):
        return await self.service.run(url, kind, self.worker, **kwargs)

    async def test_reuse_restart_keys_and_refresh(self):
        for url in ('a', 'b', 'a'):
            await self.run_media(url)
        self.assertEqual(self.calls, 2)
        self.service = TranscriptionService(self.cache, 'v1')
        result = await self.run_media()
        self.assertEqual(result.headers['X-Transcript-Cache'], 'hit')
        self.assertEqual(json.loads(result.body), BODY)
        result = await self.run_media(force_refresh=True)
        self.assertEqual(result.headers['X-Transcript-Cache'], 'refresh')
        await self.run_media(kind='video')
        await self.run_media('a?token=1')
        self.service = TranscriptionService(self.cache, 'v2')
        await self.run_media()
        self.assertEqual(self.calls, 6)

    async def test_concurrent_and_cancelled_waiter(self):
        started, release = threading.Event(), threading.Event()
        def worker():
            self.calls += 1
            started.set()
            release.wait(3)
            return JSONResponse(BODY)
        first = asyncio.create_task(self.service.run('a', 'audio', worker))
        await asyncio.to_thread(started.wait, 3)
        second = asyncio.create_task(self.service.run('a', 'audio', worker))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        self.assertEqual((await second).status_code, 200)
        self.assertEqual(self.calls, 1)

    async def test_failed_and_empty_responses_retry(self):
        for body, status in (({'message': 'failed'}, 500), ({'transcription': []}, 200)):
            calls = []
            def worker():
                calls.append(1)
                return JSONResponse(body, status_code=status)
            for _ in range(2):
                await self.service.run('a', 'audio', worker)
            self.assertEqual(len(calls), 2)

    async def test_refresh_during_normal_request(self):
        normal, refresh = await asyncio.gather(self.run_media(), self.run_media(force_refresh=True))
        self.assertEqual(refresh.headers['X-Transcript-Cache'], 'refresh')
        self.assertEqual(self.calls, 2)

    async def test_actual_endpoint_wrappers_and_config_metadata(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'api.py').read_text(encoding='utf-8'))
        names = ('transcribe_audio', 'transcribe_from_video', 'get_endpoints')
        functions = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
        for node in functions:
            node.decorator_list = []
        context = {'Item': SimpleNamespace, 'transcription_service': self.service,
                   '_transcribe_audio': lambda item: self.worker(),
                   '_transcribe_from_video': lambda item: self.worker(),
                   'config': {}, '_DEFAULT_ENDPOINTS': {'transcribe': '/api/transcribe/audio'}}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'api.py', 'exec'), context)
        for name in names[:2]:
            item = SimpleNamespace(file_url='a', force_refresh=False)
            first = await context[name](item)
            second = await context[name](item)
            self.assertEqual(first.headers['X-Transcript-Cache'], 'miss')
            self.assertEqual(second.headers['X-Transcript-Cache'], 'hit')
            item.force_refresh = True
            self.assertEqual((await context[name](item)).headers['X-Transcript-Cache'], 'refresh')
        metadata = await context['get_endpoints']()
        self.assertEqual(metadata['transcription_cache'], {'version': 'v1', 'enabled': True})
