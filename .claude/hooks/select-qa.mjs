// Qwen can skip the QA skill even when it correctly identifies a test file.
// Supply the short project guide for explicit validation and test-selection work.
import { readFileSync } from 'node:fs'

if (process.env.RUKE_CLAUDE_LOCAL === '1') {
  const { prompt = '' } = JSON.parse(readFileSync(0, 'utf8'))
  const qaTask = /\b(?:which|what)\b[^.!?\n]{0,65}\btests?\b|\b(?:validate|verify|regression tests?|test coverage|test plan|run (?:the |a |all )?(?:(?:unit|offline|integration|browser|focused) )?tests?)\b/i
  if (qaTask.test(prompt) && !/^\s*\//.test(prompt)) {
    const skill = readFileSync(new URL('../../skills/ruke-qa/SKILL.md', import.meta.url), 'utf8')
    const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Automatically selected ruke-qa. Apply the relevant checks from this guide.\n' + body
    } }))
  }
}
