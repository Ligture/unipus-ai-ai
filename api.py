import json

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
import shutil
import os
import uvicorn
import requests
import random
from pydantic import BaseModel
import uuid
import re

from openai import OpenAI


app = FastAPI()

# 配置 Whisper 模型
model_size = "base"
model = WhisperModel(".\\base", device="cuda", compute_type="float16")

class Item(BaseModel):
    file_url: str

class LLMItem(BaseModel):
    transcript: str
    questions: str




@app.post("/dtranscribe/")
async def transcribe_audio(file_url: Item):
    try:
        filename = f'{uuid.uuid4()}.wav'
        file_response = requests.get(file_url.file_url)
        data = file_response.content

        file = open(filename, "wb")
        file.write(data)
        file.close()
    except Exception as e:

        return JSONResponse(status_code=500, content={"message": str(e)})

    try:
        # 使用 Whisper 模型进行转录
        segments, info = model.transcribe(filename, beam_size=5)
        os.remove(filename)
        # 组装转录结果
        results = [{
            "start": segment.start,
            "end": segment.end,
            "text": segment.text
        } for segment in segments]

        return JSONResponse(content={
            "language": info.language,
            "language_probability": info.language_probability,
            "transcription": results
        })
    except Exception as e:
        os.remove(filename)
        return JSONResponse(status_code=500, content={"message": str(e)})


@app.post("/transcribe_from_video/")
async def transcribe_from_video(file_url: Item):
    try:
        video_filename = f'{uuid.uuid4()}.mp4'
        audio_filename = f'{uuid.uuid4()}.wav'
        file_response = requests.get(file_url.file_url)
        data = file_response.content

        file = open(video_filename, "wb")
        file.write(data)
        file.close()
        os.system(f'ffmpeg -i {video_filename} -vn -acodec pcm_s16le {audio_filename}')
        os.remove(video_filename)
    except Exception as e:
        return JSONResponse(status_code=500, content={"message": str(e)})


    try:
        # 使用 Whisper 模型进行转录
        segments, info = model.transcribe(audio_filename, beam_size=5)
        os.remove(audio_filename)
        # 组装转录结果
        results = [{
            "start": segment.start,
            "end": segment.end,
            "text": segment.text
        } for segment in segments]

        return JSONResponse(content={
            "language": info.language,
            "language_probability": info.language_probability,
            "transcription": results
        })
    except Exception as e:
        return JSONResponse(status_code=500, content={"message": str(e)})
@app.post("/get_answers/")
async def get_answers_from_llm(item: LLMItem):
    try:
        with open('config.json', "r", encoding="utf-8") as f:
            config = json.loads(f.read())



        client = OpenAI(
            base_url=config['api_url'],  # ModelScope API URL
            api_key=config['api_key'],  # ModelScope Token
        )

        response = client.chat.completions.create(
            model=config['model'],  # ModelScope Model-Id, required
            temperature=0.5,
            messages=[
                {"role": "system", "content": config['system_prompt']},

                {
                    'role': 'user',
                    'content': f'听力原文:{item.transcript},题目:{item.questions},只给出答案.'
                },


            ],

        )
        message = response.choices[0].message
        reasoning = getattr(message, 'reasoning_content', None)
        if not reasoning and hasattr(message, 'model_extra') and message.model_extra:
            reasoning = message.model_extra.get('reasoning_content')

        if reasoning:
            print(reasoning)

        print('\n\n === Final Answer ===\n')
        print(message.content)

        answer_text = response.choices[0].message.content
        
        try:
            clean_text = answer_text.strip()
            if clean_text.startswith("```"):
                clean_text = re.sub(r"^```[a-zA-Z]*\n", "", clean_text)
                clean_text = re.sub(r"\n```$", "", clean_text)
            parsed_answer = json.loads(clean_text)
        except Exception:
            parsed_answer = answer_text

        # 确保返回的 JSON 键名与脚本中的 LLM_ANSWER_KEY 匹配
        return {"answer": parsed_answer}

    except Exception as e:
        return JSONResponse(status_code=500, content={"message": str(e)})

@app.post("/get_answers_only/")
async def get_answers_only(item: LLMItem):
    try:
        with open('config.json', "r", encoding="utf-8") as f:
            config = json.loads(f.read())



        client = OpenAI(
            base_url=config['api_url'],  # ModelScope API URL
            api_key=config['api_key'],  # ModelScope Token
        )

        response = client.chat.completions.create(
            model=config['model'],  # ModelScope Model-Id, required
            temperature=0.5,
            messages=[
                {"role": "system", "content": config['system_prompt_only']},
                {
                    'role': 'user',
                    'content': f'题目:{item.questions}'
                },
            ],

        )
        message = response.choices[0].message
        reasoning = getattr(message, 'reasoning_content', None)
        if not reasoning and hasattr(message, 'model_extra') and message.model_extra:
            reasoning = message.model_extra.get('reasoning_content')

        if reasoning:
            print(reasoning)

        print('\n\n === Final Answer ===\n')
        print(message.content)

        answer_text = response.choices[0].message.content

        try:
            clean_text = answer_text.strip()
            if clean_text.startswith("```"):
                clean_text = re.sub(r"^```[a-zA-Z]*\n", "", clean_text)
                clean_text = re.sub(r"\n```$", "", clean_text)
            parsed_answer = json.loads(clean_text)
        except Exception:
            parsed_answer = answer_text

        return {"answer": parsed_answer}

    except Exception as e:
        print(e)
        return JSONResponse(status_code=500, content={"message": str(e)})



if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=28955)