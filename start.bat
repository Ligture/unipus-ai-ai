@echo off
chcp 65001 >nul 2>&1
title Unipus API Server

echo ============================================
echo   Unipus API 启动脚本 (Windows)
echo ============================================
echo.

:: 检查 Python 虚拟环境
if exist ".venv\Scripts\activate.bat" (
    echo [INFO] 激活虚拟环境 .venv ...
    call .venv\Scripts\activate.bat
) else if exist "venv\Scripts\activate.bat" (
    echo [INFO] 激活虚拟环境 venv ...
    call venv\Scripts\activate.bat
) else (
    echo [WARN] 未找到虚拟环境，使用系统 Python
)

:: 检查 config.yaml
if not exist "config.yaml" (
    echo [WARN] 未找到 config.yaml
    if exist "config.example.yaml" (
        echo [INFO] 复制 config.example.yaml -> config.yaml
        copy config.example.yaml config.yaml >nul
        echo [WARN] 请编辑 config.yaml 填入你的 API 密钥后再启动
        pause
        exit /b 1
    )
)

:: 创建必要目录
if not exist "logs" mkdir logs
if not exist "audio_files" mkdir audio_files

echo.
echo [INFO] 启动 Unipus API 服务...
echo [INFO] 按 Ctrl+C 停止服务
echo.

python api.py

pause
