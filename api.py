import json
import yaml
import subprocess
import tempfile

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from faster_whisper import WhisperModel
import shutil
import os
import uvicorn
import requests
from media_download import download_media
import random
from pydantic import BaseModel
import uuid
import re
import httpx
import logging
from datetime import datetime

from openai import OpenAI


# === 加载配置 ===
def load_config():
    # 优先读取 yaml，其次 json
    for filename in ['config.yaml', 'config.yml', 'config.json']:
        if os.path.exists(filename):
            try:
                with open(filename, 'r', encoding='utf-8') as f:
                    if filename.endswith('.yaml') or filename.endswith('.yml'):
                        return yaml.safe_load(f) or {}
                    else:
                        return json.load(f)
            except Exception as e:
                print(f"读取 {filename} 失败: {e}")
    return {}

config = load_config()

# === 日志级别映射 ===
LOG_LEVELS = {
    'DEBUG': logging.DEBUG,
    'INFO': logging.INFO,
    'WARNING': logging.WARNING,
    'ERROR': logging.ERROR,
    'CRITICAL': logging.CRITICAL,
}

def parse_log_level(level_str, default=logging.INFO):
    return LOG_LEVELS.get(level_str.upper(), default)

# === 日志系统配置 ===
LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)

log_filename = os.path.join(LOG_DIR, f"api_{datetime.now().strftime('%Y%m%d')}.log")

log_formatter = logging.Formatter(
    '%(asctime)s | %(levelname)-8s | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# 文件处理器 - 始终记录DEBUG级别
file_handler = logging.FileHandler(log_filename, encoding='utf-8')
file_handler.setFormatter(log_formatter)
file_handler.setLevel(logging.DEBUG)

# 控制台处理器 - 从config读取级别
console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)
console_log_level = parse_log_level(config.get('log_level_console', 'INFO'))
console_handler.setLevel(console_log_level)

# 主logger
file_log_level = parse_log_level(config.get('log_level', 'INFO'))
logger = logging.getLogger("unipus-api")
logger.setLevel(min(file_log_level, console_log_level))
logger.addHandler(file_handler)
logger.addHandler(console_handler)

# LLM专用日志
llm_log_filename = os.path.join(LOG_DIR, f"llm_{datetime.now().strftime('%Y%m%d')}.log")
llm_formatter = logging.Formatter('%(asctime)s\n%(message)s\n', datefmt='%Y-%m-%d %H:%M:%S')
llm_file_handler = logging.FileHandler(llm_log_filename, encoding='utf-8')
llm_file_handler.setFormatter(llm_formatter)
llm_logger = logging.getLogger("unipus-llm")
llm_logger.setLevel(logging.DEBUG)
llm_logger.addHandler(llm_file_handler)

logger.info("=" * 60)
logger.info("Unipus API 服务启动")
logger.info(f"日志文件: {log_filename}")
logger.info(f"LLM日志: {llm_log_filename}")
logger.info(f"日志级别 - 文件: {config.get('log_level', 'INFO')} | 终端: {config.get('log_level_console', 'INFO')}")


app = FastAPI()

# === CORS 跨域支持 ===
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === Endpoint 配置 ===
_DEFAULT_ENDPOINTS = {
    "transcribe": "/api/transcribe/audio",
    "video": "/api/transcribe/video",
    "llm": "/api/llm/answer",
    "text": "/api/llm/text",
    "tts": "/api/tts/generate",
    "audio_files": "/api/audio",
}

@app.get("/api/config/endpoints")
async def get_endpoints():
    """返回所有 endpoint 路径配置，支持 config.yaml 中的 endpoints 字段覆盖"""
    custom = config.get('endpoints', {})
    merged = {**_DEFAULT_ENDPOINTS, **custom}
    return merged


# 加载代理配置
proxy_config = config.get('proxy', {'enabled': False})
logger.info(f"代理配置: enabled={proxy_config.get('enabled')}")

def is_proxy_enabled(scope):
    """独立开关优先，未配置时兼容旧的 enabled 字段。"""
    return bool(proxy_config.get(f'{scope}_enabled', proxy_config.get('enabled', False)))

logger.info(f"代理开关: LLM={is_proxy_enabled('llm')}, 媒体下载={is_proxy_enabled('media')}")

# 清除系统代理环境变量，防止自动读取系统代理
for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']:
    os.environ.pop(key, None)

# 如果未启用代理，设置空的环境变量强制禁用
if not (is_proxy_enabled('llm') or is_proxy_enabled('media')):
    os.environ['NO_PROXY'] = '*'
    os.environ['no_proxy'] = '*'
    logger.info("代理已禁用，使用直连模式")
else:
    logger.info(f"代理已启用: http={proxy_config.get('http')}, https={proxy_config.get('https')}")

# 创建httpx客户端（支持代理配置）
def create_http_client():
    if is_proxy_enabled('llm'):
        http_proxy = proxy_config.get('http', '')
        https_proxy = proxy_config.get('https', '')
        proxy_url = https_proxy or http_proxy
        if proxy_url:
            logger.info(f"创建httpx客户端，代理: {proxy_url}")
            return httpx.Client(proxy=proxy_url, trust_env=False)
    return httpx.Client(proxy=None, trust_env=False)

http_client = create_http_client()

# 创建requests代理配置
def get_requests_proxies():
    if is_proxy_enabled('media'):
        http_proxy = proxy_config.get('http', '')
        https_proxy = proxy_config.get('https', '')
        if http_proxy or https_proxy:
            return {
                'http': http_proxy or None,
                'https': https_proxy or None
            }
    return {'http': None, 'https': None}

# 配置 Whisper 模型
whisper_model_path = config.get('whisper_model', './base')
logger.info(f"正在加载 Whisper 模型: {whisper_model_path}")
try:
    model = WhisperModel(whisper_model_path, device="cuda", compute_type="float16")
    logger.info("Whisper 模型加载成功 (CUDA float16)")
except Exception as e:
    logger.error(f"Whisper CUDA 加载失败: {e}，尝试 CPU 模式...")
    try:
        model = WhisperModel(whisper_model_path, device="cpu", compute_type="int8")
        logger.info("Whisper 模型加载成功 (CPU int8)")
    except Exception as e2:
        logger.critical(f"Whisper 模型加载完全失败: {e2}")
        raise


class Item(BaseModel):
    file_url: str

class LLMItem(BaseModel):
    transcript: str
    questions: str


@app.post("/api/transcribe/audio")
async def transcribe_audio(file_url: Item):
    request_id = str(uuid.uuid4())[:8]
    logger.info(f"[{request_id}] 音频转录请求 | URL: {file_url.file_url[:100]}")

    tmp_file = None
    try:
        logger.debug(f"[{request_id}] 下载音频: {file_url.file_url}")
        tmp_file = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        tmp_file.close()
        size = download_media(file_url.file_url, tmp_file.name,
                              proxies=get_requests_proxies(), logger=logger)
        logger.info(f"[{request_id}] 音频下载完成 | 大小: {size} bytes")
    except Exception as e:
        logger.error(f"[{request_id}] 音频下载失败: {e}")
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)
        return JSONResponse(status_code=500, content={"message": str(e)})

    try:
        logger.info(f"[{request_id}] 开始 Whisper 转录...")
        segments, info = model.transcribe(tmp_file.name, beam_size=5)

        results = [{
            "start": segment.start,
            "end": segment.end,
            "text": segment.text
        } for segment in segments]

        logger.info(f"[{request_id}] 转录完成 | 语言: {info.language} | 概率: {info.language_probability:.2f} | 片段数: {len(results)}")
        logger.debug(f"[{request_id}] 转录内容: {json.dumps(results, ensure_ascii=False)[:500]}")

        return JSONResponse(content={
            "language": info.language,
            "language_probability": info.language_probability,
            "transcription": results
        })
    except Exception as e:
        logger.error(f"[{request_id}] 转录失败: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"message": str(e)})
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)


@app.post("/api/transcribe/video")
async def transcribe_from_video(file_url: Item):
    request_id = str(uuid.uuid4())[:8]
    logger.info(f"[{request_id}] 视频转录请求 | URL: {file_url.file_url[:100]}")

    tmp_video = None
    tmp_audio = None
    try:
        logger.debug(f"[{request_id}] 下载视频: {file_url.file_url}")
        tmp_video = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        tmp_video.close()
        size = download_media(file_url.file_url, tmp_video.name,
                              proxies=get_requests_proxies(), logger=logger)
        logger.info(f"[{request_id}] 视频下载完成 | 大小: {size} bytes")

        tmp_audio = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        tmp_audio.close()

        logger.info(f"[{request_id}] FFmpeg 提取音频...")
        result = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_video.name, '-vn', '-acodec', 'pcm_s16le', tmp_audio.name],
            capture_output=True, text=True
        )

        if result.returncode != 0:
            raise Exception(f"FFmpeg 退出码: {result.returncode} | {result.stderr[:300]}")
    except Exception as e:
        logger.error(f"[{request_id}] 视频处理失败: {e}")
        for f in [tmp_video, tmp_audio]:
            if f and os.path.exists(f.name):
                os.unlink(f.name)
        return JSONResponse(status_code=500, content={"message": str(e)})

    try:
        logger.info(f"[{request_id}] 开始 Whisper 转录...")
        segments, info = model.transcribe(tmp_audio.name, beam_size=5)

        results = [{
            "start": segment.start,
            "end": segment.end,
            "text": segment.text
        } for segment in segments]

        logger.info(f"[{request_id}] 转录完成 | 语言: {info.language} | 片段数: {len(results)}")
        return JSONResponse(content={
            "language": info.language,
            "language_probability": info.language_probability,
            "transcription": results
        })
    except Exception as e:
        logger.error(f"[{request_id}] 转录失败: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"message": str(e)})
    finally:
        for f in [tmp_video, tmp_audio]:
            if f and os.path.exists(f.name):
                os.unlink(f.name)


@app.post("/api/llm/answer")
async def get_answers_from_llm(item: LLMItem):
    request_id = str(uuid.uuid4())[:8]
    logger.info(f"[{request_id}] LLM答案请求 (带听力) | 题目长度: {len(item.questions)} | 转录长度: {len(item.transcript)}")

    try:
        config = load_config()

        client = OpenAI(
            base_url=config['api_url'],
            api_key=config['api_key'],
            http_client=http_client,
        )

        user_content = f'听力原文:{item.transcript},题目:{item.questions},只给出答案.'
        messages = [
            {"role": "system", "content": config['system_prompt']},
            {"role": "user", "content": user_content},
        ]

        # 记录完整prompt到LLM日志
        llm_logger.info(f"[{request_id}] === LLM请求 (带听力) ===")
        llm_logger.info(f"模型: {config['model']}")
        llm_logger.info(f"API: {config['api_url']}")
        llm_logger.info(f"--- System Prompt ---\n{config['system_prompt']}")
        llm_logger.info(f"--- User Content ---\n{user_content}")
        llm_logger.info(f"--- End ---\n")

        logger.info(f"[{request_id}] 发送LLM请求 | 模型: {config['model']}")
        response = client.chat.completions.create(
            model=config['model'],
            temperature=0.5,
            messages=messages,
        )

        message = response.choices[0].message
        reasoning = getattr(message, 'reasoning_content', None)
        if not reasoning and hasattr(message, 'model_extra') and message.model_extra:
            reasoning = message.model_extra.get('reasoning_content')

        answer_text = message.content

        # 记录完整回复到LLM日志
        llm_logger.info(f"[{request_id}] === LLM回复 (带听力) ===")
        if reasoning:
            llm_logger.info(f"--- Reasoning ---\n{reasoning}")
        llm_logger.info(f"--- Answer ---\n{answer_text}")
        llm_logger.info(f"--- End ---\n")

        logger.info(f"[{request_id}] LLM回复成功 | 回复长度: {len(answer_text)}")
        if reasoning:
            logger.debug(f"[{request_id}] Reasoning: {reasoning[:200]}...")

        try:
            clean_text = answer_text.strip()
            if clean_text.startswith("```"):
                clean_text = re.sub(r"^```[a-zA-Z]*\n", "", clean_text)
                clean_text = re.sub(r"\n```$", "", clean_text)
            parsed_answer = json.loads(clean_text)
            logger.info(f"[{request_id}] JSON解析成功")
        except Exception:
            parsed_answer = answer_text
            logger.info(f"[{request_id}] 返回纯文本答案")

        return {"answer": parsed_answer}

    except Exception as e:
        logger.error(f"[{request_id}] LLM请求失败: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"message": str(e)})


@app.post("/api/llm/text")
async def get_answers_only(item: LLMItem):
    request_id = str(uuid.uuid4())[:8]
    logger.info(f"[{request_id}] LLM答案请求 (仅题目) | 题目长度: {len(item.questions)}")

    try:
        config = load_config()

        client = OpenAI(
            base_url=config['api_url'],
            api_key=config['api_key'],
            http_client=http_client,
        )

        user_content = f'题目:{item.questions}'
        messages = [
            {"role": "system", "content": config['system_prompt_only']},
            {"role": "user", "content": user_content},
        ]

        # 记录完整prompt到LLM日志
        llm_logger.info(f"[{request_id}] === LLM请求 (仅题目) ===")
        llm_logger.info(f"模型: {config['model']}")
        llm_logger.info(f"API: {config['api_url']}")
        llm_logger.info(f"--- System Prompt ---\n{config['system_prompt_only']}")
        llm_logger.info(f"--- User Content ---\n{user_content}")
        llm_logger.info(f"--- End ---\n")

        logger.info(f"[{request_id}] 发送LLM请求 | 模型: {config['model']}")
        response = client.chat.completions.create(
            model=config['model'],
            temperature=0.5,
            messages=messages,
        )

        message = response.choices[0].message
        reasoning = getattr(message, 'reasoning_content', None)
        if not reasoning and hasattr(message, 'model_extra') and message.model_extra:
            reasoning = message.model_extra.get('reasoning_content')

        answer_text = message.content

        # 记录完整回复到LLM日志
        llm_logger.info(f"[{request_id}] === LLM回复 (仅题目) ===")
        if reasoning:
            llm_logger.info(f"--- Reasoning ---\n{reasoning}")
        llm_logger.info(f"--- Answer ---\n{answer_text}")
        llm_logger.info(f"--- End ---\n")

        logger.info(f"[{request_id}] LLM回复成功 | 回复长度: {len(answer_text)}")
        if reasoning:
            logger.debug(f"[{request_id}] Reasoning: {reasoning[:200]}...")

        try:
            clean_text = answer_text.strip()
            if clean_text.startswith("```"):
                clean_text = re.sub(r"^```[a-zA-Z]*\n", "", clean_text)
                clean_text = re.sub(r"\n```$", "", clean_text)
            parsed_answer = json.loads(clean_text)
            logger.info(f"[{request_id}] JSON解析成功")
        except Exception:
            parsed_answer = answer_text
            logger.info(f"[{request_id}] 返回纯文本答案")

        return {"answer": parsed_answer}

    except Exception as e:
        logger.error(f"[{request_id}] LLM请求失败: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"message": str(e)})


# === TTS 语音合成 (Piper TTS) ===

class TTSItem(BaseModel):
    text: str
    length_scale: float = None  # 语速控制: <1.0加快, >1.0减慢, None则使用配置默认值

_tts_config = config.get('tts', {})
_tts_default_length_scale = _tts_config.get('length_scale', 1.0)
AUDIO_DIR = _tts_config.get('output_dir', './audio_files')
os.makedirs(AUDIO_DIR, exist_ok=True)

# 启动时加载 Piper 模型
_tts_model_path = _tts_config.get('model', './models/en_US-lessac-medium.onnx')
_piper_voice = None

try:
    from piper import PiperVoice
    import wave as wave_module
    _piper_voice = PiperVoice.load(_tts_model_path)
    logger.info(f"Piper TTS 模型加载成功: {_tts_model_path}")
except Exception as e:
    logger.error(f"Piper TTS 模型加载失败: {e}")


@app.post("/api/tts/generate")
async def tts_generate(item: TTSItem):
    request_id = str(uuid.uuid4())[:8]
    length_scale = item.length_scale if item.length_scale is not None else _tts_default_length_scale
    text_preview = item.text[:80] + ('...' if len(item.text) > 80 else '')
    logger.info(f"[{request_id}] TTS生成请求 | length_scale: {length_scale} | 文本: {text_preview}")

    if not _piper_voice:
        return JSONResponse(status_code=500, content={"message": "Piper TTS 模型未加载"})

    try:
        from piper.config import SynthesisConfig
        filename = f"{uuid.uuid4()}.wav"
        output_path = os.path.join(AUDIO_DIR, filename)

        syn_config = SynthesisConfig(length_scale=length_scale)
        with wave_module.open(output_path, "wb") as wav_file:
            _piper_voice.synthesize_wav(item.text, wav_file, syn_config=syn_config)

        file_size = os.path.getsize(output_path)
        logger.info(f"[{request_id}] TTS生成完成 | 文件: {filename} | 大小: {file_size} bytes")

        return {"audio_url": f"/api/audio/{filename}"}

    except Exception as e:
        logger.error(f"[{request_id}] TTS生成失败: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"message": str(e)})


@app.get("/api/audio")
async def list_audio_files():
    """列出可用的音频文件"""
    files = []
    if os.path.exists(AUDIO_DIR):
        for f in os.listdir(AUDIO_DIR):
            if f.endswith(('.wav', '.mp3', '.ogg', '.m4a')):
                path = os.path.join(AUDIO_DIR, f)
                files.append({
                    "name": f,
                    "size": os.path.getsize(path),
                })
    return {"files": files}


@app.get("/api/audio/{filename}")
async def get_audio_file(filename: str):
    """提供音频文件下载"""
    # 防止路径遍历
    safe_name = os.path.basename(filename)
    path = os.path.join(AUDIO_DIR, safe_name)
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"message": "File not found"})

    content_type = "audio/wav"
    if safe_name.endswith('.mp3'):
        content_type = "audio/mpeg"
    elif safe_name.endswith('.ogg'):
        content_type = "audio/ogg"

    return FileResponse(path, media_type=content_type, filename=safe_name)


if __name__ == "__main__":
    server_config = config.get('server', {})
    host = server_config.get('host', '0.0.0.0')
    port = server_config.get('port', 28955)
    logger.info(f"启动 uvicorn 服务器 | {host}:{port}")
    uvicorn.run(app, host=host, port=port)
