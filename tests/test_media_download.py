"""Exercise real truncated HTTP bodies and Range recovery without external media."""
import http.server
import ast
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import uuid

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
PAYLOAD = bytes(range(256)) * 128
CHANGED_PAYLOAD = b"replacement-media" * 2048


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.calls.append(dict(self.headers))
        number = len(self.server.calls)
        if self.path == "/forbidden":
            self.send_error(403)
            return
        offset = int(self.headers.get("Range", "bytes=0-")[6:-1])
        payload = CHANGED_PAYLOAD if self.path == "/changed" and number > 1 else PAYLOAD
        if self.path in ("/ignore-range", "/changed") and number > 1:
            offset = 0
        status = 206 if offset else 200
        self.send_response(status)
        self.send_header("Content-Length", str(len(payload) - offset))
        self.send_header("ETag", '"changed"' if payload is CHANGED_PAYLOAD else '"original"')
        if status == 206:
            range_start = offset + 1 if self.path == "/bad-range" else offset
            self.send_header("Content-Range", f"bytes {range_start}-{len(payload)-1}/{len(payload)}")
        self.end_headers()
        body = payload[offset:]
        if self.path == "/always-broken" or (number == 1 and self.path != "/complete"):
            body = body[:8192]
        self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True
        try:
            self.connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.calls = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.directory = tempfile.TemporaryDirectory()
        self.destination = Path(self.directory.name) / "media.bin"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def url(self, path):
        return f"http://127.0.0.1:{self.server.server_port}{path}"

    def download(self, path, **kwargs):
        from media_download import download_media
        return download_media(self.url(path), self.destination, proxies={"http": None, "https": None},
                              chunk_size=4096, retry_delay=0, **kwargs)

    def test_original_download_reproduces_incomplete_read(self):
        with self.assertRaises(requests.exceptions.ChunkedEncodingError) as failure:
            requests.get(self.url("/broken"), proxies={"http": None, "https": None}).content
        self.assertIn("IncompleteRead", str(failure.exception))

    def test_complete_response(self):
        self.assertEqual(self.download("/complete"), len(PAYLOAD))
        self.assertEqual(self.destination.read_bytes(), PAYLOAD)

    def test_resume_after_truncation(self):
        self.assertEqual(self.download("/broken"), len(PAYLOAD))
        self.assertEqual(self.destination.read_bytes(), PAYLOAD)
        self.assertEqual(self.server.calls[1]["Range"], "bytes=8192-")
        self.assertEqual(self.server.calls[1]["If-Range"], '"original"')

    def test_multiple_disconnects(self):
        self.assertEqual(self.download("/always-broken"), len(PAYLOAD))
        self.assertEqual(self.destination.read_bytes(), PAYLOAD)
        self.assertEqual(len(self.server.calls), 4)

    def test_ignored_range_restarts_without_duplicate_bytes(self):
        self.download("/ignore-range")
        self.assertEqual(self.destination.read_bytes(), PAYLOAD)

    def test_changed_resource_restarts(self):
        self.download("/changed")
        self.assertEqual(self.destination.read_bytes(), CHANGED_PAYLOAD)

    def test_retry_limit_keeps_partial_file_for_caller_cleanup(self):
        with self.assertRaises(requests.RequestException):
            self.download("/always-broken", attempts=2)
        self.assertEqual(len(self.server.calls), 2)
        self.assertEqual(self.destination.stat().st_size, 16384)

    def test_invalid_range_is_rejected(self):
        with self.assertRaises(requests.RequestException):
            self.download("/bad-range", attempts=2)
        self.assertEqual(self.destination.read_bytes(), PAYLOAD[:8192])

    def test_permanent_http_error_is_not_retried(self):
        with self.assertRaises(requests.HTTPError):
            self.download("/forbidden")
        self.assertEqual(len(self.server.calls), 1)

    def run_api_endpoint(self, endpoint, path):
        # Compile the actual endpoint functions, without app startup/model loads.
        # The HTTP download and temporary-file lifecycle remain real.
        from fastapi.responses import JSONResponse
        from media_download import download_media
        source = ast.parse((Path(__file__).resolve().parents[1] / "api.py").read_text(encoding="utf-8"))
        function = next(node for node in source.body if isinstance(node, ast.AsyncFunctionDef)
                        and node.name == endpoint)
        function.decorator_list = []
        self.transcribed = []

        def transcribe(filename, **kwargs):
            self.transcribed.append(Path(filename).read_bytes())
            return iter([SimpleNamespace(start=0, end=1, text="recognized")]), SimpleNamespace(
                language="en", language_probability=1)

        def extract(command, **kwargs):
            Path(command[-1]).write_bytes(Path(command[3]).read_bytes())
            return SimpleNamespace(returncode=0, stderr="")

        context = {"Item": SimpleNamespace, "uuid": uuid, "logger": Mock(), "tempfile": tempfile,
                   "os": os, "json": json, "download_media": download_media,
                   "get_requests_proxies": lambda: {"http": None, "https": None},
                   "JSONResponse": JSONResponse, "model": SimpleNamespace(transcribe=transcribe),
                   "subprocess": SimpleNamespace(run=extract)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "api.py", "exec"), context)
        factory = tempfile.NamedTemporaryFile

        def temporary(**kwargs):
            return factory(dir=self.directory.name, **kwargs)

        with patch.object(tempfile, "NamedTemporaryFile", side_effect=temporary):
            return asyncio.run(context[endpoint](SimpleNamespace(file_url=self.url(path))))

    def test_audio_endpoint_recovers_and_cleans_up(self):
        response = self.run_api_endpoint("transcribe_audio", "/broken")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.transcribed, [PAYLOAD])
        self.assertEqual(json.loads(response.body)["transcription"][0]["text"], "recognized")
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_video_endpoint_recovers_before_extraction_and_cleans_up(self):
        response = self.run_api_endpoint("transcribe_from_video", "/broken")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.transcribed, [PAYLOAD])
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_endpoint_download_failure_cleans_up_without_inference(self):
        response = self.run_api_endpoint("transcribe_from_video", "/forbidden")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.transcribed, [])
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
