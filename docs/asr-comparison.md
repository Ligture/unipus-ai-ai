# 本地 SenseVoice 与现有 Whisper 比较

实测日期：2026-10-03。结论：**模型常驻时，SenseVoice 更快；Whisper base 占用内存和显存更少，首次启动也更快。**

## 安装及使用

`D:\Project\audio_transcription`（cxkitty-audio-transcription 0.1.0）已安装到本项目 `.asr-runtime`。它要求 Python ≥3.11，因此复用 `D:\Project\search_via_bilibili\.venv\Scripts\python.exe` 及该环境已有的 FunASR/PyTorch 依赖。这个安装目录不是独立虚拟环境，运行时仍依赖上述 Python 3.11 环境。

模型根目录：`D:\Project\search_via_bilibili\models`，含完整的 `sensevoice-small` 和 `fsmn-vad`。包及模型无需重新下载。安装命令：

```powershell
& 'D:\Project\search_via_bilibili\.venv\Scripts\python.exe' -m pip install --target 'D:\Project\Unipus-ai\.asr-runtime' --no-deps 'D:\Project\audio_transcription' psutil
```

在本项目执行：

```powershell
.\scripts\transcribe_local.ps1 -InputPath '你的音频或视频路径' -OutputPath '.\benchmark-results\transcript.json'
```

默认设备 `auto`，语言 `auto`；可传 `-Device cpu` 或 `-Language en`。脚本临时配置 Python 导入路径和本项目 ffmpeg 路径，退出后恢复环境变量。当前 API 的转录后端仍为 Whisper；SenseVoice 可通过此独立脚本使用。

## 有效语音测试结果

硬件：i7-13650HX（14 核 / 20 线程），RTX 5060 Laptop GPU（8151 MiB）。

四段同样的音频，共 **45.392875 秒**，全部先归一化为 16 kHz、单声道 PCM WAV：

- 项目音频 `31c0e013-b165-4903-88f9-3cc8cacea070.wav`：17.252438 秒，英语。
- 项目音频 `b60b5f26-08e2-4bab-8a70-c393723a2e23.wav`：15.348438 秒，英语。
- SenseVoice 随模型提供的 `example/en.mp3`：7.176 秒。
- SenseVoice 随模型提供的 `example/zh.mp3`：5.616 秒。

每种配置使用独立进程，先加载模型、用第一段音频预热，再重复三轮。下表耗时为每轮四段音频总耗时的中位数，排除模型加载、预热、统一音频转换和网络下载。模型按当前实现默认设置运行，未强制设置相同精度或线程数。

| 配置 | 转录耗时 | 相对 Whisper 同设备速度 | 全过程峰值内存 | 转录阶段峰值内存 | GPU 显存增量（近似） |
|---|---:|---:|---:|---:|---:|
| Whisper base，CUDA float16 | 1.194 秒 | 1× | 728 MiB | 728 MiB | 394 MiB |
| SenseVoiceSmall + VAD，CUDA | 0.740 秒 | **1.61×** | 3564 MiB | 2416 MiB | 1158 MiB |
| Whisper base，CPU int8 | 6.313 秒 | 1× | 329 MiB | 329 MiB | 不使用 GPU |
| SenseVoiceSmall + VAD，CPU | 3.120 秒 | **2.02×** | 3492 MiB | 3492 MiB | 不使用 GPU |

三轮总耗时，单位秒：Whisper GPU `[1.088, 1.194, 1.203]`；SenseVoice GPU `[0.828, 0.727, 0.740]`；Whisper CPU `[5.523, 6.313, 6.324]`；SenseVoice CPU `[3.259, 3.120, 3.117]`。

内存每 50 ms 采样一次，统计 Windows 虚拟环境启动器与实际推理子进程的进程树 RSS。全过程峰值包含模型加载期间的临时分配。GPU 指标为 NVML 读取的整卡峰值用量减去该进程启动前基线，受其他桌面程序影响，并非精确的单进程显存；本次其他程序基线约 2.5 GiB。采样可能漏掉极短峰值。

GPU 推理期间的平均 CPU 用量，Whisper 约 **0.96 个逻辑核心**，SenseVoice 约 **3.84 个逻辑核心**。CPU 推理时两者都约 **3.96 个逻辑核心**；SenseVoice 完成得更快，总 CPU 时间也更低。这些是进程 CPU 时间除以转录墙钟时间，不是整机 CPU 使用率或能耗测量。

主模型权重文件：SenseVoice `model.pt` 约 893 MiB，Whisper base `model.bin` 约 138 MiB；模型大小及推理框架不同，不能把本次结果解释为同规模模型的架构比较。

## 首次使用成本

| 配置 | 导入依赖及加载模型 | 首次预热转录（17.25 秒音频） | 合计 |
|---|---:|---:|---:|
| Whisper GPU | 0.57 秒 | 0.78 秒 | 1.35 秒 |
| SenseVoice GPU | 11.82 秒 | 16.27 秒 | 28.09 秒 |
| Whisper CPU | 0.50 秒 | 1.11 秒 | 1.61 秒 |
| SenseVoice CPU | 10.76 秒 | 1.27 秒 | 12.03 秒 |

这是新进程首次使用，不是清空操作系统缓存后的磁盘冷启动。SenseVoice GPU 首次推理初始化成本明显；应复用同一 `LocalSenseVoiceTranscriber` 对象。每次重新运行命令行都会重新加载模型，所以短音频单次命令行调用并不享有表中的常驻速度优势。

## 转录文本观察

没有人工校对的标准文本，本次不报告 WER/CER 或宣称整体准确率排名。原始输出保存在本地结果 JSON 中，可逐段复核。

- 英文示例：Whisper 输出 `tribal thief then`；SenseVoice 输出 `tribal chieftain`。
- 数字及物资描述：Whisper 输出 `4,010s`；SenseVoice 输出 `4000 tents`，但 SenseVoice 也出现 `waterproof canvassed`。
- 中文示例：Whisper 输出 `開放時間早上9點,墜下5點`；SenseVoice 前两轮输出 `开饭时间早上9点至下午5点。`，第三轮输出 `开放时间早上9点至下午5点。`。两者都有需要核对的词，SenseVoice 的标点和后半句更完整，但输出存在轮次差异。

默认样本偏英语，仅一条短中文音频；其中两条是 SenseVoice 自带示例，不能视为独立质量评测集，也没有覆盖嘈杂录音、长篇连续课程或完整的模型语言范围。前期使用的两段约 144–148 秒项目音频几乎没有有效语音文本，且当时只采样了 Windows 启动器内存；那些初步结果已排除，不作为本报告依据。

## 选择建议与复现

连续转录、可以让模型常驻且资源充足：优先试用 **SenseVoice**。GPU 在本次有效语音上快约 1.6 倍，CPU 快约 2 倍。

要求低内存、低显存、较少 GPU 推理期间 CPU 占用，或经常单次启动处理短音频：保留 **Whisper base** 更合适。课程场景正式切换前，需用更多真实课程音频核对识别错误和时间戳。

依赖版本：现有 Whisper 使用 Python 3.10.0、faster-whisper 1.2.1、CTranslate2 4.7.1；SenseVoice 使用 Python 3.11.0、torch/torchaudio 2.11.0+cu128、FunASR 1.4.2、ModelScope 1.39.1；监测工具 psutil 7.2.2。SenseVoice 按本地包默认配置启用 FSMN-VAD、`batch_size_s=60`、`merge_vad=True`、`merge_length_s=15`、句级时间戳；Whisper 按现有 API 使用 `beam_size=5`，并在计时范围内完整消费 segment 生成器。

```powershell
& 'D:\Project\search_via_bilibili\.venv\Scripts\python.exe' .\scripts\benchmark_asr.py --output .\benchmark-results\validated
```

可用 `--audio 路径1 路径2` 替换样本，`--devices cuda` 或 `--devices cpu` 单测设备，`--repeats 3` 设置重复次数。原始结果：`benchmark-results/validated/results.json`；每种配置有独立 JSON 和日志。结果、音频和安装目录已加入 `.gitignore`。
