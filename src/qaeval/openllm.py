import json
import logging
import os
import re
from typing import Optional, Sequence, Union
from tqdm import tqdm

import datasets
import ftfy
import torch
from torch.utils.data import DataLoader
from transformers import (
    AutoConfig,
    AutoModelForCausalLM,
    AutoModelForSeq2SeqLM,
    AutoTokenizer,
    DataCollatorWithPadding,
    DataCollatorForSeq2Seq,
)
import requests

from .data_utils import Candidate

logger = logging.getLogger("openllm")


CONVERSATIONAL_MODELS = {
    "meta-llama/Llama-2-7b-chat-hf",
    "meta-llama/Llama-2-13b-chat-hf",
    "mistralai/Mistral-7B-Instruct-v0.1",
    "HuggingFaceH4/zephyr-7b-beta",
    "allenai/tulu-2-7b",
    "allenai/tulu-2-dpo-7b",
}

MODEL_KWARGS = {
    "bigscience/T0pp": {"torch_dtype": torch.bfloat16},
    "bigscience/T0_3B": {"torch_dtype": torch.bfloat16},
    "google/flan-ul2": {"load_in_8bit": True},
    "google/flan-t5-xxl": {"load_in_8bit": True},
    "google/flan-t5-xl": {"load_in_8bit": True},
    "google/flan-t5-large": {"load_in_8bit": True},
    "google/flan-t5-base": {"load_in_8bit": True},
}


TULU_CHAT_TEMPLATE = {
    "chat_template": "{% for message in messages %}\n{% if message['role'] == 'user' %}\n{{ '<|user|>\n' + message['content'] + eos_token }}\n{% elif message['role'] == 'system' %}\n{{ '<|system|>\n' + message['content'] + eos_token }}\n{% elif message['role'] == 'assistant' %}\n{{ '<|assistant|>\n'  + message['content'] + eos_token }}\n{% endif %}\n{% if loop.last and add_generation_prompt %}\n{{ '<|assistant|>' }}\n{% endif %}\n{% endfor %}"
}
TOKENIZER_KWARGS = {
    "allenai/tulu-2-7b": TULU_CHAT_TEMPLATE,
    "allenai/tulu-2-dpo-7b": TULU_CHAT_TEMPLATE,
}


def _is_conversational(model_name_or_path):
    return model_name_or_path in CONVERSATIONAL_MODELS


def _prepare(
    candidates, prompt_file: os.PathLike, model_name_or_path: str, context_file: Optional[os.PathLike] = None
):
    with open(prompt_file) as p:
        prompt_template = "".join(p.readlines()).strip()

    context_passage = None
    if context_file and os.path.exists(context_file):
        with open(context_file, "r") as json_file:
            context_passage = json.load(json_file)

    prompts = []
    for candidate in candidates:
        if isinstance(candidate, Candidate):
            q = candidate.question
            gold_answers = q.answers
            candidate_answer = candidate.answer
            question = q.text
        else:
            gold_answers = candidate["answers"]
            candidate_answer = candidate["candidate_answer"]
            question = candidate["question"]

        gold_answers = ", ".join([f'"{a}"' for a in gold_answers])

        if not question.endswith("?"):
            question += "?"

        if context_passage:
            passage = context_passage.get(question, context_passage.get(question[:-1], None))
            prompt = prompt_template.format(
                q=question, answers=gold_answers, candidate_answer=candidate_answer, passage=passage
            )
        else:
            prompt = prompt_template.format(q=question, answers=gold_answers, candidate_answer=candidate_answer)

        if _is_conversational(model_name_or_path):
            if "Mistral" in model_name_or_path or "tulu-2" in model_name_or_path:
                instruction = None
                content = prompt
            else:
                sections = prompt.split("###")
                instruction = "###".join(sections[:-1]) if len(sections) > 1 else None
                content = sections[-1].strip()

            chat = []
            if instruction:
                chat.append({"role": "system", "content": instruction})

            chat.append({"role": "user", "content": content})
            prompts.append(chat)
        else:
            prompts.append(prompt)

    return prompts


def _prepare_second_pass(chats, model_responses):
    new_chats = []
    for chat, resp in zip(chats, model_responses):
        history = []
        if chat and chat[0]["role"] == "system":
            history.append(chat[1:])
        else:
            history.extend(chat)

        if isinstance(resp, str):
            resp = [resp]

        for r in resp:
            if "###" in r:
                r = r.split("###")[0].strip()

            new_chats.append(
                history
                + [
                    {"role": "assistant", "content": r},
                    {"role": "user", "content": "Please tell me your final judgment in only 'yes' or 'no'"},
                ]
            )

    return new_chats


def _parse_response(response: str, candidate_answer: str, question: str) -> int:
    patterns = [
        r".*['\"]?(yes|no)\.?['\"]?[.!]?$",
        r".*I can answer\s+['\"]?(yes|no)['\"]?[.!]?",
        r".*I would say\s+['\"]?(yes|no)['\"]?[.!]?",
        r".*I must say\s+['\"]?(yes|no)['\"]?[.!]?",
        (r".*my (final )?judgment is\s+['\"]?(yes|no)['\"]?[.!]?", 2),
        r".*I would judge the candidate answer as\s+['\"]?(yes|no)['\"]?[.!]?",
        r".*\s+['\"]?(yes|no)['\"]?,? the candidate( answer)? is",
        r".*[jJ]udgment:\s+['\"]?(yes|no)\.?['\"]?",
    ]
    correct_patterns = [r"candidate( answer)? is correct", r"candidate's correct"]

    if response.lower().startswith("yes"):
        acceptable = "Yes"
    elif response.lower().startswith("no"):
        acceptable = "No"
    else:
        acceptable = ""
        for pattern in patterns:
            match_idx = 1
            if isinstance(pattern, (list, tuple)):
                pattern, match_idx = pattern

            matched = re.match(pattern, response, re.IGNORECASE | re.MULTILINE | re.DOTALL)

            if matched:
                acceptable = matched.group(match_idx).capitalize()
                break
        if not acceptable:
            for pattern in correct_patterns:
                matched = re.search(pattern, response, re.IGNORECASE | re.MULTILINE | re.DOTALL)
                if matched:
                    acceptable = "Yes"
                    break

        if not acceptable:
            logger.warning(f"Invalid response to `{question}` & `{candidate_answer}`: {response}")

    return int(acceptable == "Yes")


def run_inference(
    texts: Union[str, Sequence[str]],
    model,
    tokenizer,
    max_new_tokens: int = 256,
    do_sample: bool = True,
    top_p: float = 1.0,
    num_beams: int = 1,
    batch_size: int = 1,
    num_workers: int = 16,
    num_return_sequences: int = 1,
):
    if isinstance(texts, str):
        texts = [texts]
    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")

    model.eval()

    dataset = datasets.Dataset.from_list(
        [
            {
                "text": (
                    tokenizer.apply_chat_template(t, tokenize=False, add_generation_prompt=True)
                    if _is_conversational(model.config.name_or_path)
                    else t
                )
            }
            for t in texts
        ]
    )

    dataset = dataset.map(
        lambda sample: tokenizer(sample["text"]),
        batched=True,
        remove_columns=list(dataset.features),
    )

    test_dataloader = DataLoader(
        dataset,
        batch_size=batch_size,
        num_workers=num_workers,
        pin_memory=True,
        collate_fn=DataCollatorForSeq2Seq(tokenizer, padding="longest")
        if model.config.is_encoder_decoder
        else DataCollatorWithPadding(tokenizer, padding="longest"),
    )

    outputs = []
    for batch in tqdm(test_dataloader):
        for key in batch.keys():
            batch[key] = batch[key].to(device)

        batch_size, seq_length = batch["input_ids"].shape

        with torch.no_grad():
            output = model.generate(
                **batch,
                do_sample=do_sample,
                max_new_tokens=max_new_tokens,
                top_p=top_p,
                num_beams=num_beams,
                num_return_sequences=num_return_sequences,
            )

        output = output.reshape(batch_size, num_return_sequences, -1)

        for b in range(batch_size):
            output_ids = output[b]

            _outs = []
            for s in range(num_return_sequences):
                _ids = output_ids[s]
                if not model.config.is_encoder_decoder:
                    _ids = _ids[seq_length:]

                _outs.append(ftfy.fix_encoding(tokenizer.decode(_ids, skip_special_tokens=True).strip()))

            outputs.append(_outs[0] if len(_outs) == 1 else _outs)

    return outputs


def llm_eval(model_name_or_path: str, candidates, **kwargs):
    prompt_file = kwargs.pop("prompt_file", None)
    context_file = kwargs.pop("context_file", None)
    num_return_sequences = kwargs.pop("num_return_sequences", 1)

    assert prompt_file and os.path.exists(prompt_file), "prompt_file is required in llm_eval"

    examples = _prepare(candidates, prompt_file, model_name_or_path, context_file)
    
    # Ollama API로 프롬프트 전송 및 응답 수집
    responses = []
    for prompt in tqdm(examples):
        # chat 형식이면 마지막 user 메시지만 추출
        if isinstance(prompt, list):
            if prompt[-1]["role"] == "user":
                prompt_text = prompt[-1]["content"]
            else:
                prompt_text = prompt[-1]
        else:
            prompt_text = prompt
        try:
            resp = requests.post(
                "http://localhost:11434/api/generate",
                json={"model": model_name_or_path, "prompt": prompt_text, "stream": False}
            )
            result = resp.json()
            responses.append(result["response"])
        except Exception as e:
            logger.warning(f"Ollama API 호출 실패: {e}")
            responses.append("")
    original_responses = responses

    # 기존 LLM 평가 방식과 동일하게 파싱
    outputs = []
    for index in range(len(candidates)):
        num_judgments = 1
        judgments = []
        resp = responses[index]
        judgments.append(_parse_response(resp, candidates[index].answer, candidates[index].question.text))
        acceptable_count = sum(judgments)
        outputs.append((round(acceptable_count / num_judgments), original_responses[index], judgments))

    return outputs
