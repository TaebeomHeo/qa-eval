// openllm.js - LLM 평가 모듈 (Ollama 또는 OpenAI API 사용)
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { llmEval as ollamaEval } from './ollama.js';
import { llmEval as gptEval } from './askGPT.js';

// 환경 변수 로드
config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 전역 설정
const DEFAULT_CONFIG = {
    model: process.env.DEFAULT_MODEL || 'mistral',
    promptPath: process.env.DEFAULT_PROMPT_PATH || path.join(__dirname, '../../prompts/eval-v0.1-zero-shot.txt'),
    candidatesPath: process.env.DEFAULT_CANDIDATES_PATH || path.join(__dirname, '../../data/candidates.tsv')
};

/**
 * TSV 파일에서 candidates를 읽어오는 함수
 * @param {string} filePath - TSV 파일 경로
 * @returns {Promise<Array>} candidates 배열
 */
async function readCandidatesFromTSV(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        // 헤더 제거
        const headers = lines[0].split('\t');
        const data = lines.slice(1);

        return data.map((line, index) => {
            const [question, answers, candidate_answer] = line.split('\t');
            return {
                lineNumber: index + 2, // 2번 라인부터 시작
                question,
                answers: answers.split(',').map(a => a.trim()),
                candidate_answer
            };
        });
    } catch (error) {
        logger.error(`TSV 파일 읽기 실패: ${error.message}`);
        throw error;
    }
}

// command line argument 파싱
function parseArgs() {
    const args = process.argv.slice(2);
    const config = { ...DEFAULT_CONFIG };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--model' && args[i + 1]) {
            config.model = args[++i];
        } else if (arg === '--prompt' && args[i + 1]) {
            config.promptPath = args[++i];
        } else if (arg === '--candidates' && args[i + 1]) {
            config.candidatesPath = args[++i];
        } else if (arg === '--help') {
            console.log(`
사용법: node openllm.js [옵션]

옵션:
  --model <모델명>        모델명 (기본값: ${DEFAULT_CONFIG.model})
                        - Ollama 모델: mistral, zephyr:7b, llama2, vicuna:13b 등
                        - OpenAI 모델: gpt-3.5-turbo, gpt-4 등
  --prompt <경로>         프롬프트 파일 경로 (기본값: ${DEFAULT_CONFIG.promptPath})
  --candidates <경로>     후보 답변 TSV 파일 경로 (기본값: ${DEFAULT_CONFIG.candidatesPath})
  --help                 도움말 표시

TSV 파일 형식:
  question<TAB>answers<TAB>candidate_answer
  answers는 콤마(,)로 구분된 문자열
예시:
  What is the capital of France?<TAB>Paris,Paris City<TAB>Paris

주의사항:
  1. Ollama 모델 사용 시 Ollama가 설치되어 있어야 합니다.
  2. OpenAI 모델 사용 시 OPENAI_API_KEY 환경변수가 설정되어 있어야 합니다.
            `);
            process.exit(0);
        }
    }

    return config;
}

// 로깅 설정
const logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warning: (...args) => console.warn('[WARNING]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
};

// 테스트 실행 함수
async function runTest() {
    try {
        const config = parseArgs();

        // 프롬프트 파일 존재 확인
        try {
            await fs.access(config.promptPath);
        } catch (error) {
            logger.error(`프롬프트 파일을 찾을 수 없습니다: ${config.promptPath}`);
            return;
        }

        // candidates 파일 존재 확인
        try {
            await fs.access(config.candidatesPath);
        } catch (error) {
            logger.error(`candidates 파일을 찾을 수 없습니다: ${config.candidatesPath}`);
            return;
        }

        logger.info('=== 설정 ===');
        logger.info('모델:', config.model);
        logger.info('프롬프트:', config.promptPath);
        logger.info('Candidates:', config.candidatesPath);
        logger.info('===================');

        // candidates 읽기
        const candidates = await readCandidatesFromTSV(config.candidatesPath);
        logger.info(`총 ${candidates.length}개의 후보 답변을 읽었습니다.`);

        // 프롬프트 템플릿 읽기
        const promptTemplate = await fs.readFile(config.promptPath, 'utf-8');

        logger.info('평가 시작...');
        // 모델명에 따라 적절한 API 선택
        const results = config.model.startsWith('gpt-')
            ? await gptEval(config.model, candidates, promptTemplate)
            : await ollamaEval(config.model, candidates, promptTemplate);

        // 결과 출력
        logger.info('=== 평가 결과 ===');
        results.forEach((score, index) => {
            const candidate = candidates[index];
            console.log(`${candidate.lineNumber} -> ${score}`);
        });
        logger.info('===================');
    } catch (error) {
        logger.error('테스트 실행 중 오류:', error);
    }
}

// 테스트 실행
runTest();