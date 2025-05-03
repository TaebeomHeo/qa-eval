# NOTE: Ollama 기반 vicuna 평가에는 openllm.py를 사용하세요. 이 파일은 별도 실험/데모용입니다.
import argparse
import requests

import torch

from FastChat.fastchat.model import load_model, get_conversation_template, add_model_args


@torch.inference_mode()
def infer_vicuna(prompt="Hello", model_name="lmsys/vicuna-13b-v1.5-16k"):
    # Ollama API로 프롬프트 전송
    try:
        resp = requests.post(
            "http://localhost:11434/api/generate",
            json={"model": model_name, "prompt": prompt, "stream": False}
        )
        result = resp.json()
        outputs = result["response"]
    except Exception as e:
        print(f"Ollama API 호출 실패: {e}")
        outputs = ""

    print("-"*20)
    print(f"user: {prompt}")
    print(f"vicuna: {outputs}")
    print("-"*20)
    return outputs

infer_vicuna(prompt="Hello, who are you?")