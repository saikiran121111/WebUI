/**
 * VENDORED verbatim from the independent audit workspace fixture
 * audit-regate-policy-boundaries.test.ts (audit baseline 60fe172). No
 * deviation whatsoever.
 */
import {it,expect,vi,afterEach} from 'vitest';
import {runSearchGate} from '@/lib/web-search/search-gate';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
for(const prompt of [
 'Do not browse. What is the latest version of Node.js? State that you cannot verify it.',
 'Do not search the web. What is the weather in Hyderabad now?',
 'Translate “What is the current weather?” into Hindi.',
])it('respects local instruction scope: '+prompt,async()=>{
 vi.stubEnv('WEB_SEARCH_GATE_DISABLED','');vi.stubEnv('WEB_SEARCH_LFM_DISABLED','');
 const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({search_required:false,reason:'User requested a local answer',freshness:'none',depth:'quick',queries:[]})}}]}),{status:200}));
 vi.stubGlobal('fetch',fetch);
 const result=await runSearchGate({userPrompt:prompt});
 expect(result.decision.search_required,JSON.stringify(result)).toBe(false);
 expect(result.decision.queries).toEqual([]);
});
