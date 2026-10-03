"""Compare installed SenseVoice with the project's existing faster-whisper.

Run with the Python 3.11 runtime that supplies FunASR/PyTorch dependencies.
The local package and psutil are installed into .asr-runtime. Results and
normalized audio remain local under benchmark-results (gitignored).
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".asr-runtime"))
MODEL_ROOT = Path(r"D:\Project\search_via_bilibili\models")
SENSE_PYTHON = Path(r"D:\Project\search_via_bilibili\.venv\Scripts\python.exe")


def emit(value):
    print("ASR_BENCH " + json.dumps(value, ensure_ascii=True), flush=True)


def worker(args):
    samples = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    emit({"phase": "load"})
    started = time.perf_counter()
    if args.engine == "sensevoice":
        from audio_transcription import LocalSenseVoiceTranscriber
        import torch
        model = LocalSenseVoiceTranscriber.from_model_root(MODEL_ROOT, device=args.device)
        model.load()

        def transcribe(path):
            result = model.transcribe(path, language="auto")
            return {"text": result.text, "language": result.language,
                    "segments": len(result.segments)}

        def synchronize():
            if args.device == "cuda":
                torch.cuda.synchronize()
    else:
        from faster_whisper import WhisperModel
        model = WhisperModel(str(ROOT / "base"), device=args.device,
                             compute_type="float16" if args.device == "cuda" else "int8")

        def transcribe(path):
            segments, info = model.transcribe(path, beam_size=5)
            segments = list(segments)  # Consume lazy inference inside the timed region.
            return {"text": "".join(s.text for s in segments),
                    "language": info.language, "segments": len(segments)}

        def synchronize():
            pass  # Materializing the segments completes CTranslate2 inference.

    synchronize()
    load_s = time.perf_counter() - started
    emit({"phase": "warmup", "load_s": load_s})
    started = time.perf_counter()
    transcribe(samples[0]["path"])
    synchronize()
    warmup_s = time.perf_counter() - started
    runs = []
    for repeat in range(args.repeats):
        for sample in samples:
            emit({"phase": "inference"})
            synchronize()
            started = time.perf_counter()
            cpu_started = time.process_time()
            result = transcribe(sample["path"])
            synchronize()
            elapsed = time.perf_counter() - started
            cpu_s = time.process_time() - cpu_started
            runs.append({"sample": sample["name"], "repeat": repeat,
                         "audio_s": sample["duration_s"], "wall_s": elapsed,
                         "cpu_s": cpu_s, **result})
            emit({"phase": "idle", "sample": sample["name"], "wall_s": elapsed})
    emit({"result": {"engine": args.engine, "device": args.device,
                     "load_s": load_s, "warmup_s": warmup_s, "runs": runs}})


class GpuMemory:
    """Read whole-device used memory via NVML; Windows lacks process VRAM accounting."""
    class Info(ctypes.Structure):
        _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong),
                    ("used", ctypes.c_ulonglong)]

    def __init__(self):
        self.lib = ctypes.WinDLL("nvml.dll")
        if self.lib.nvmlInit_v2() != 0:
            raise RuntimeError("NVML initialization failed")
        self.handle = ctypes.c_void_p()
        if self.lib.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(self.handle)) != 0:
            raise RuntimeError("NVML GPU lookup failed")

    def used_mb(self):
        info = self.Info()
        if self.lib.nvmlDeviceGetMemoryInfo(self.handle, ctypes.byref(info)) != 0:
            raise RuntimeError("NVML memory query failed")
        return info.used / 1024**2


def prepare(output, sources=None):
    if sources is None:
        # Screened project samples contain complete English sentences.
        sources = [ROOT / "audio_files" / name for name in (
            "31c0e013-b165-4903-88f9-3cc8cacea070.wav",
            "b60b5f26-08e2-4bab-8a70-c393723a2e23.wav")]
        sources = [p for p in sources if p.is_file()]
        sources += [MODEL_ROOT / "sensevoice-small" / "example" / f"{lang}.mp3"
                    for lang in ("en", "zh")]
    samples = []
    for index, source in enumerate(sources):
        target = output / f"sample-{index}.wav"
        subprocess.run([str(ROOT / "ffmpeg.exe"), "-y", "-i", str(source),
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        with wave.open(str(target)) as audio:
            duration = audio.getnframes() / audio.getframerate()
        samples.append({"name": source.name, "source": str(source),
                        "path": str(target), "duration_s": duration})
    manifest = output / "samples.json"
    manifest.write_text(json.dumps(samples, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest, samples


def measure(engine, device, manifest, repeats, output, gpu):
    import psutil
    python = SENSE_PYTHON if engine == "sensevoice" else ROOT / ".venv/Scripts/python.exe"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1",
               PYTHONDONTWRITEBYTECODE="1", HF_HUB_OFFLINE="1", MODELSCOPE_OFFLINE="1")
    command = [str(python), str(Path(__file__).resolve()), "--worker", "--engine", engine,
               "--device", device, "--manifest", str(manifest), "--repeats", str(repeats)]
    baseline = gpu.used_mb() if gpu else None
    state = {"phase": "startup", "stopped": False}
    peaks = {}
    monitoring_errors = []
    started = time.perf_counter()
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                               errors="replace")
    child = psutil.Process(process.pid)

    def monitor():
        while not state["stopped"]:
            try:
                # Windows venv python.exe can be a small launcher whose child
                # does the actual inference. Include its complete process tree.
                rss = 0
                for member in [child, *child.children(recursive=True)]:
                    try:
                        rss += member.memory_info().rss / 1024**2
                    except psutil.NoSuchProcess:
                        pass
                vram = gpu.used_mb() if gpu else None
                for phase in ("overall", state["phase"]):
                    record = peaks.setdefault(phase, {"rss_mb": 0, "device_vram_mb": None})
                    record["rss_mb"] = max(record["rss_mb"], rss)
                    if vram is not None:
                        record["device_vram_mb"] = max(record["device_vram_mb"] or 0, vram)
            except psutil.NoSuchProcess:
                break
            except Exception as exc:
                monitoring_errors.append(str(exc))
                break
            time.sleep(0.05)

    sampler = threading.Thread(target=monitor, daemon=True)
    sampler.start()
    result = None
    with (output / f"{engine}-{device}.log").open("w", encoding="utf-8") as log:
        for line in process.stdout:
            log.write(line)
            log.flush()
            if line.startswith("ASR_BENCH "):
                event = json.loads(line[len("ASR_BENCH "):])
                if "phase" in event:
                    state["phase"] = event["phase"]
                if "result" in event:
                    result = event["result"]
                print(f"{engine}/{device}: {event.get('phase', 'done')}"
                      + (f" {event['wall_s']:.3f}s" if "wall_s" in event else ""), flush=True)
    code = process.wait()
    state["stopped"] = True
    sampler.join()
    elapsed = time.perf_counter() - started
    if code or result is None:
        result = {"engine": engine, "device": device, "error": f"Worker exit {code}; see log"}
    result.update({"process_wall_s": elapsed, "gpu_baseline_mb": baseline,
                   "peaks": peaks, "monitoring_errors": monitoring_errors})
    if "runs" in result:
        totals = []
        for repeat in range(repeats):
            runs = [r for r in result["runs"] if r["repeat"] == repeat]
            totals.append(sum(r["wall_s"] for r in runs))
        audio_s = sum(r["audio_s"] for r in result["runs"] if r["repeat"] == 0)
        result["summary"] = {"audio_s": audio_s, "repeat_total_s": totals,
                             "median_total_s": statistics.median(totals),
                             "rtf": statistics.median(totals) / audio_s,
                             "cpu_core_equivalents": sum(r["cpu_s"] for r in result["runs"])
                             / sum(r["wall_s"] for r in result["runs"])}
    (output / f"{engine}-{device}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--engine", choices=["whisper", "sensevoice"])
    parser.add_argument("--device", choices=["cpu", "cuda"])
    parser.add_argument("--manifest")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path, default=ROOT / "benchmark-results")
    parser.add_argument("--engines", nargs="+", choices=["whisper", "sensevoice"],
                        default=["whisper", "sensevoice"])
    parser.add_argument("--devices", nargs="+", choices=["cuda", "cpu"], default=["cuda", "cpu"])
    parser.add_argument("--audio", nargs="+", type=Path,
                        help="Optional audio files replacing the screened default corpus")
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    if args.worker:
        worker(args)
        return
    args.output.mkdir(parents=True, exist_ok=True)
    manifest, samples = prepare(args.output, args.audio)
    try:
        gpu = GpuMemory()
    except Exception as exc:
        print(f"GPU memory monitoring unavailable: {exc}", flush=True)
        gpu = None
    results = []
    for device in args.devices:
        for engine in args.engines:
            results.append(measure(engine, device, manifest, args.repeats, args.output, gpu))
            (args.output / "results.json").write_text(
                json.dumps({"samples": samples, "results": results}, ensure_ascii=False, indent=2),
                encoding="utf-8")
    print(json.dumps([{k: r.get(k) for k in ("engine", "device", "summary", "error")}
                      for r in results], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
