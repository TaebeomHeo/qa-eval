// askGPT.js - OpenAI API를 사용한 LLM 평가 모듈
import fetch from 'node-fetch';
import { config } from 'dotenv';

// 환경 변수 로드
config();

// 로깅 설정
const logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warning: (...args) => console.warn('[WARNING]', ...args),
    error: (...args) => console.error('[ERROR]', ...args)
};

/**
 * OpenAI API를 통해 프롬프트를 전송하고 응답을 받는 함수
 * @param {string} prompt - 전송할 프롬프트
 * @param {string} modelName - OpenAI 모델명 (예: 'gpt-3.5-turbo', 'gpt-4')
 * @returns {Promise<string>} 모델의 응답
 */
async function sendToOpenAI(prompt, modelName) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.');
        }

        logger.info('=== OpenAI API 호출 ===');
        logger.info('모델:', modelName);
        logger.info('프롬프트:', prompt);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful assistant that evaluates question answering responses.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        const answer = result.choices[0].message.content;
        logger.info('응답:', answer);
        logger.info('===================');
        return answer;
    } catch (error) {
        logger.error(`OpenAI API 호출 실패: ${error.message}`);
        return '';
    }
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
 * @param {string} modelName - OpenAI 모델명
 * @param {Array} candidates - 평가할 후보 답변 배열
 * @param {string} promptTemplate - 프롬프트 템플릿
 * @returns {Promise<Array>} 평가 결과 배열
 */
export async function llmEval(modelName, candidates, promptTemplate) {
    try {
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

            const prompt = promptTemplate
                .replace('{q}', candidate.question)
                .replace('{answers}', candidate.answers.join(', '))
                .replace('{candidate_answer}', candidate.candidate_answer);

            const response = await sendToOpenAI(prompt, modelName);
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