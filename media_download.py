"""Stream media to disk and resume interrupted HTTP responses safely."""
import logging
from pathlib import Path
import re
import time

import requests


def download_media(url, destination, *, proxies=None, attempts=8,
                   timeout=(10, 60), chunk_size=256 * 1024, retry_delay=1,
                   logger=None):
    """Download into a new temporary file; return its complete size in bytes.

    The caller owns cleanup on success and failure. Range resumes are checked
    before appending. A server returning 200 to a Range request starts a fresh
    file, including when If-Range detects a changed resource.
    """
    if attempts < 1 or chunk_size < 1:
        raise ValueError("attempts and chunk_size must be positive")
    destination = Path(destination)
    destination.write_bytes(b"")
    expected_total = None
    validator = None
    log = logger or logging.getLogger(__name__)
    for attempt in range(attempts):
        offset = destination.stat().st_size
        headers = {"Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
            if validator:
                headers["If-Range"] = validator
        try:
            with requests.get(url, proxies=proxies, headers=headers,
                              timeout=timeout, stream=True) as response:
                response.raise_for_status()
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise requests.RequestException("Media response must use identity encoding")
                etag = response.headers.get("ETag")
                response_validator = (etag if etag and not etag.startswith("W/") else
                                      response.headers.get("Last-Modified"))
                if response.status_code == 206:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)",
                                         response.headers.get("Content-Range", ""))
                    if not match:
                        raise requests.RequestException("Missing or invalid Content-Range")
                    start, end, total = map(int, match.groups())
                    if start != offset or not start <= end < total:
                        raise requests.RequestException("Content-Range does not match resume offset")
                    if expected_total is not None and expected_total != total:
                        raise requests.RequestException("Media size changed during resume")
                    if validator and response_validator and validator != response_validator:
                        raise requests.RequestException("Media validator changed during resume")
                    expected_total = total
                    mode = "ab"
                elif response.status_code == 200:
                    # A Range request can legitimately receive a full body.
                    offset = 0
                    mode = "wb"
                    length = response.headers.get("Content-Length")
                    try:
                        expected_total = int(length) if length is not None else None
                    except ValueError as exc:
                        raise requests.RequestException("Invalid media Content-Length") from exc
                    validator = response_validator
                else:
                    raise requests.RequestException(f"Unexpected media HTTP status {response.status_code}")
                with destination.open(mode) as output:
                    for chunk in response.iter_content(chunk_size=chunk_size):
                        if chunk:
                            output.write(chunk)
                            offset += len(chunk)
                if not offset or (expected_total is not None and offset != expected_total):
                    raise requests.ConnectionError(
                        f"Incomplete media download: received {offset} of {expected_total} bytes")
                return offset
        except requests.RequestException as exc:
            if isinstance(exc, requests.HTTPError):
                status = exc.response.status_code if exc.response is not None else None
                if status is not None and status < 500 and status not in (408, 429):
                    raise
            if attempt + 1 == attempts:
                raise
            log.warning("媒体下载中断 (%s)，已保存 %d bytes；重试 %d/%d",
                        type(exc).__name__, destination.stat().st_size, attempt + 2, attempts)
            time.sleep(min(retry_delay * 2**attempt, 4))
