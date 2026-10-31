/**
 * The question a session is waiting on, for the Pokédex (sessionDetail.question):
 * an open AskUserQuestion with its options, a plan waiting for approval
 * (ExitPlanMode while Claude reports requires_action), or a question a Codex
 * agent asked without stopping (`delivery: 'async'`), open until the next user
 * message. Read from the reconstructed normalizer state, so it reflects the
 * feed as far as it was read.
 */

import type { SessionQuestion } from '../../../../../core/src/messages.js';
import { QUESTION_OPTION_MAX, QUESTION_OPTIONS_MAX, QUESTION_TEXT_MAX } from './constants.js';
import { asRecord, asString, clipText, type NormState } from './normalize/shared.js';
import { ASK_USER_QUESTION_TOOL, EXIT_PLAN_MODE_TOOL } from './tools.js';

/** Trimmed and cut to `max`, keeping line breaks (a plan is markdown). */
function clipBlock(text: string, max: number): string {
  const trimmed = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function cleanOptions(options: unknown[]): string[] | undefined {
  const labels = options
    .map((o) => (typeof o === 'string' ? o : asString(asRecord(o)?.label)))
    .filter((o): o is string => !!o && o.trim().length > 0)
    .slice(0, QUESTION_OPTIONS_MAX)
    .map((o) => clipText(o, QUESTION_OPTION_MAX));
  return labels.length > 0 ? labels : undefined;
}

function askUserQuestion(input: unknown): SessionQuestion | undefined {
  const questions = asRecord(input)?.questions;
  const first = Array.isArray(questions) ? asRecord(questions[0]) : undefined;
  const text = asString(first?.question) ?? asString(first?.header);
  if (!text?.trim()) return undefined;
  const more = Array.isArray(questions) && questions.length > 1 ? questions.length - 1 : 0;
  const question: SessionQuestion = {
    kind: 'askUser',
    text: clipBlock(more > 0 ? `${text} (+${more} more)` : text, QUESTION_TEXT_MAX),
  };
  const options = Array.isArray(first?.options) ? cleanOptions(first.options) : undefined;
  if (options) question.options = options;
  return question;
}

export function pendingQuestion(norm: NormState): SessionQuestion | undefined {
  for (const tool of norm.openTools.values()) {
    if (tool.name !== ASK_USER_QUESTION_TOOL) continue;
    const question = askUserQuestion(tool.input);
    if (question) return question;
  }
  if (norm.permissionPending) {
    for (const tool of norm.openTools.values()) {
      if (tool.name !== EXIT_PLAN_MODE_TOOL) continue;
      const plan = asString(asRecord(tool.input)?.plan)?.trim();
      return {
        kind: 'plan',
        text: plan ? clipBlock(plan, QUESTION_TEXT_MAX) : 'Plan ready for review',
      };
    }
  }
  if (norm.asyncQuestion) {
    const question: SessionQuestion = {
      kind: 'notice',
      text: clipBlock(norm.asyncQuestion.text, QUESTION_TEXT_MAX),
    };
    const options = norm.asyncQuestion.options
      ? cleanOptions(norm.asyncQuestion.options)
      : undefined;
    if (options) question.options = options;
    return question;
  }
  return undefined;
}
