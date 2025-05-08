# QA Evaluation

Question Answering (QA) 모델의 성능을 평가하는 도구입니다.

## 설치 방법

### Python 버전

```bash
pip install -e .
```

### Node.js 버전

```bash
npm install
```

## 사용 방법

### Python 버전

```bash
python -m qaeval.eval \
    --model mistral \
    --prompt prompts/eval-v0.1-zero-shot.txt \
    --candidates data/candidates.tsv
```

### Node.js 버전

```bash
node src/qaeval/openllm.js \
    --model mistral \
    --prompt prompts/eval-v0.1-zero-shot.txt \
    --candidates data/candidates.tsv
```

#### Node.js 버전 옵션

- `--model <모델명>`: Ollama 모델명 (기본값: mistral)
- `--prompt <경로>`: 프롬프트 파일 경로
- `--candidates <경로>`: 후보 답변 TSV 파일 경로
- `--help`: 도움말 표시

#### TSV 파일 형식

```
question<TAB>answers<TAB>candidate_answer
```

- `question`: 평가할 질문
- `answers`: 콤마(,)로 구분된 정답 목록
- `candidate_answer`: 모델이 생성한 답변

예시:

```
What is the capital of France?<TAB>Paris,Paris City<TAB>Paris
```

## Ollama 모델 사용

Node.js 버전은 Ollama API를 사용하여 모델을 실행합니다. 다음 모델들을 사용할 수 있습니다:

- mistral
- zephyr:7b
- llama2
- vicuna:13b
- 기타 Ollama에 설치된 모델

## 평가 메트릭

- EM (Exact Match)
- F1 Score
- Rouge Score

## 프로젝트 구조

```
.
├── data/
│   └── candidates.tsv    # 평가할 후보 답변
├── prompts/
│   └── eval-v0.1-zero-shot.txt  # 평가 프롬프트
├── src/
│   └── qaeval/
│       ├── eval.py      # Python 버전 메인 스크립트
│       └── openllm.js   # Node.js 버전 메인 스크립트
└── README.md
```

## 주의사항

1. Node.js 버전을 사용하기 위해서는 Ollama가 설치되어 있어야 합니다.
2. Ollama 서버가 실행 중이어야 합니다 (기본 포트: 11434).
3. 사용하려는 모델이 Ollama에 설치되어 있어야 합니다.

## 라이선스

MIT License
