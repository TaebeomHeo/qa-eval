// openllm.js - Ollama API를 사용한 LLM 평가 모듈
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 전역 설정
const DEFAULT_CONFIG = {
    model: 'mistral',
    promptPath: path.join(__dirname, '../../prompts/eval-v0.1-zero-shot.txt'),
    candidatesPath: path.join(__dirname, '../../data/candidates.tsv')
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

        return data.map(line => {
            const [question, answers, candidate_answer] = line.split('\t');
            return {
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
  --model <모델명>        Ollama 모델명 (기본값: ${DEFAULT_CONFIG.model})
  --prompt <경로>         프롬프트 파일 경로 (기본값: ${DEFAULT_CONFIG.promptPath})
  --candidates <경로>     후보 답변 TSV 파일 경로 (기본값: ${DEFAULT_CONFIG.candidatesPath})
  --help                 도움말 표시

TSV 파일 형식:
  question<TAB>answers<TAB>candidate_answer
  answers는 콤마(,)로 구분된 문자열
예시:
  What is the capital of France?<TAB>Paris,Paris City<TAB>Paris
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

/**
 * Ollama API를 통해 프롬프트를 전송하고 응답을 받는 함수
 * @param {string} prompt - 전송할 프롬프트
 * @param {string} modelName - Ollama 모델명 (예: 'mistral', 'zephyr:7b', 'vicuna:13b')
 * @returns {Promise<string>} 모델의 응답
 */
async function sendToOllama(prompt, modelName) {
    try {
        logger.info('=== Ollama API 호출 ===');
        logger.info('모델:', modelName);
        logger.info('프롬프트:', prompt);

        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                prompt: prompt,
                stream: false
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        logger.info('응답:', result.response);
        logger.info('===================');
        return result.response || '';
    } catch (error) {
        logger.error(`Ollama API 호출 실패: ${error.message}`);
        return '';
    }
}

/**
 * 프롬프트 템플릿을 준비하는 함수
 * @param {Object} candidate - 평가할 후보 답변 객체
 * @param {string} promptTemplate - 프롬프트 템플릿
 * @returns {string} 완성된 프롬프트
 */
function preparePrompt(candidate, promptTemplate) {
    const { question, answers, candidate_answer } = candidate;
    const gold_answers = answers.join(', ');

    return promptTemplate
        .replace('{q}', question)
        .replace('{answers}', gold_answers)
        .replace('{candidate_answer}', candidate_answer);
}

/**
 * 모델의 응답을 파싱하여 yes/no 판단을 반환하는 함수
 * @param {string} response - 모델의 응답
 * @param {string} candidateAnswer - 후보 답변
 * @param {string} question - 질문
 * @returns {number} 1(yes) 또는 0(no)
 */
function parseResponse(response, candidateAnswer, question) {
    // 응답 전처리: 앞뒤 공백 제거 및 소문자 변환
    const cleanResponse = response.trim().toLowerCase();

    // "yes" 또는 "no"로 시작하는 경우
    if (cleanResponse.startsWith('yes')) {
        return 1;
    }
    if (cleanResponse.startsWith('no')) {
        return 0;
    }

    // "yes" 또는 "no"를 포함하는 패턴들
    const patterns = [
        /.*['"]?(yes|no)\.?['"]?[.!]?$/i,
        /.*I can answer\s+['"]?(yes|no)['"]?[.!]?/i,
        /.*I would say\s+['"]?(yes|no)['"]?[.!]?/i,
        /.*I must say\s+['"]?(yes|no)['"]?[.!]?/i,
        /.*my (final )?judgment is\s+['"]?(yes|no)['"]?[.!]?/i,
        /.*I would judge the candidate answer as\s+['"]?(yes|no)['"]?[.!]?/i,
        /.*\s+['"]?(yes|no)['"]?,? the candidate( answer)? is/i,
        /.*[jJ]udgment:\s+['"]?(yes|no)\.?['"]?/i,
        /.*the candidate( answer)? is (correct|incorrect)/i,
        /.*the answer is (correct|incorrect)/i
    ];

    // 긍정적인 표현을 포함하는 패턴들
    const positivePatterns = [
        /candidate( answer)? is correct/i,
        /candidate's correct/i,
        /answer is correct/i,
        /correct answer/i,
        /matches the ground-truth/i,
        /is accurate/i,
        /is valid/i
    ];

    // 부정적인 표현을 포함하는 패턴들
    const negativePatterns = [
        /candidate( answer)? is incorrect/i,
        /candidate's incorrect/i,
        /answer is incorrect/i,
        /incorrect answer/i,
        /does not match/i,
        /is inaccurate/i,
        /is invalid/i
    ];

    // 패턴 매칭 시도
    for (const pattern of patterns) {
        const match = cleanResponse.match(pattern);
        if (match) {
            const answer = match[1]?.toLowerCase();
            if (answer === 'yes' || answer === 'correct') return 1;
            if (answer === 'no' || answer === 'incorrect') return 0;
        }
    }

    // 긍정/부정 패턴 확인
    for (const pattern of positivePatterns) {
        if (pattern.test(cleanResponse)) {
            return 1;
        }
    }

    for (const pattern of negativePatterns) {
        if (pattern.test(cleanResponse)) {
            return 0;
        }
    }

    // 응답에 "yes" 또는 "no"가 포함되어 있는지 확인
    if (cleanResponse.includes('yes')) return 1;
    if (cleanResponse.includes('no')) return 0;

    logger.warning(`Invalid response to \`${question}\` & \`${candidateAnswer}\`: ${response}`);
    return 0;
}

/**
 * LLM 평가를 실행하는 메인 함수
 * @param {string} modelName - Ollama 모델명
 * @param {Array} candidates - 평가할 후보 답변 배열
 * @param {string} promptFile - 프롬프트 템플릿 파일 경로
 * @returns {Promise<Array>} 평가 결과 배열
 */
export async function llmEval(modelName, candidates, promptFile) {
    try {
        // 프롬프트 템플릿 읽기
        const promptTemplate = await fs.readFile(promptFile, 'utf-8');
        logger.info('=== 프롬프트 템플릿 ===');
        logger.info(promptTemplate);
        logger.info('===================');

        // 각 후보에 대해 평가 수행
        const results = [];
        for (const candidate of candidates) {
            logger.info('=== 평가 항목 ===');
            logger.info('질문:', candidate.question);
            logger.info('정답:', candidate.answers);
            logger.info('후보 답변:', candidate.candidate_answer);

            const prompt = preparePrompt(candidate, promptTemplate);
            const response = await sendToOllama(prompt, modelName);
            const score = parseResponse(response, candidate.candidate_answer, candidate.question);
            results.push(score);

            logger.info('점수:', score);
            logger.info('===================');
        }

        return results;
    } catch (error) {
        logger.error(`평가 중 오류 발생: ${error.message}`);
        throw error;
    }
}

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

        logger.info('평가 시작...');
        const results = await llmEval(config.model, candidates, config.promptPath);
        logger.info('평가 결과:', results);
    } catch (error) {
        logger.error('테스트 실행 중 오류:', error);
    }
}

// 테스트 실행
runTest();