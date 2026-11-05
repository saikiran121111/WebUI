/**
 * VENDORED verbatim from the independent audit workspace fixture
 * audit-regate-decision-matrix.test.ts (audit baseline 60fe172). The ONLY
 * deviation: the afterAll observations-file write (an audit-workspace path
 * artifact) is removed. Zero assertions changed.
 */
import {it,expect,vi,afterEach} from 'vitest';
import {runSearchGate} from '@/lib/web-search/search-gate';
type Case={id:string,prompt:string,want:boolean,extra?:any};
const cases:Case[]=[
 {id:'smalltalk-screenshot',prompt:'what are you doing today',want:false},
 {id:'smalltalk-currently',prompt:'How are you feeling currently?',want:false},
 {id:'smalltalk-latest',prompt:'Thanks for your latest reply!',want:false},
 {id:'smalltalk-now',prompt:'What are you up to right now?',want:false},
 {id:'smalltalk-greeting',prompt:'Hello!',want:false},
 {id:'smalltalk-identity',prompt:'Who are you?',want:false},
 {id:'clock-date',prompt:"What is today's date?",want:false,extra:{currentDate:'2026-11-04'}},
 {id:'clock-weekday',prompt:'What day is it today?',want:false,extra:{currentDate:'2026-11-04'}},
 {id:'clock-current-date',prompt:'Tell me the current date.',want:false,extra:{currentDate:'2026-11-04'}},
 {id:'write-weather',prompt:'Write a poem about the weather.',want:false},
 {id:'write-fiction-news',prompt:'Write a fictional news headline about a dragon.',want:false},
 {id:'write-named-character',prompt:'Write a fictional story about Alice and Bob.',want:false},
 {id:'translate-price',prompt:"Translate this text into Hindi: The price is high today.",want:false},
 {id:'proofread-site',prompt:'Proofread this sentence: The website is down today.',want:false},
 {id:'rewrite-release',prompt:'Rewrite this paragraph: Our latest release is ready.',want:false},
 {id:'quoted-source-url',prompt:'Summarize this supplied text without opening links: Our portal is https://example.com.',want:false},
 {id:'code-url-literal',prompt:'Explain this code: const url = "https://example.com";',want:false},
 {id:'code-weather',prompt:'Write a function that returns the string "current weather".',want:false},
 {id:'code-stock',prompt:'Write a Python function to compute an average of supplied stock prices.',want:false},
 {id:'code-offline',prompt:'Write Python code for binary search.',want:false},
 {id:'code-version-explanation',prompt:'Explain the syntax of this Python 3.10 match statement.',want:false},
 {id:'math',prompt:'What is 15 * 17?',want:false},
 {id:'concept-newton',prompt:"Explain Newton's first law.",want:false},
 {id:'concept-capitalization',prompt:'Explain Binary Search.',want:false},
 {id:'concept-lowercase',prompt:'explain binary search',want:false},
 {id:'stable-historical',prompt:'Who wrote Pride and Prejudice?',want:false},
 {id:'local-attachment-latest',prompt:'Summarize the latest paragraph in the attached document.',want:false,extra:{hasAttachmentEvidence:true}},
 {id:'local-attachment-video',prompt:'Transcribe the attached video.',want:false,extra:{hasAttachmentEvidence:true}},
 {id:'no-web-current-price',prompt:'Do not search the web. Explain the concept of current price from memory.',want:false},
 {id:'no-web-volatile',prompt:'Do not browse. What is the current milk price? State if you cannot verify it.',want:false},
 {id:'no-web-url',prompt:'Do not search the web. Count the characters in https://example.com.',want:false},
 {id:'hello-history',prompt:'what are you doing today',want:false,extra:{history:[{role:'user',content:'Read https://maps.example.com/location'}]}},
 {id:'timeless-current-in-quote',prompt:'Explain the phrase "current affairs" without fetching any news.',want:false},
 {id:'stable-summary-local-fact',prompt:'Summarize the supplied article about NASA. It says the mission launched in 1969.',want:false},
 {id:'live-price-zepto',prompt:'What is the current milk price in Zepto?',want:true},
 {id:'live-price-generic',prompt:'What is the current price in the website I named?',want:true},
 {id:'live-weather',prompt:"What is today's weather in Hyderabad?",want:true},
 {id:'live-release',prompt:'What is the latest version of Node.js?',want:true},
 {id:'live-office-holder',prompt:'Who is the CEO of Acme Corp?',want:true},
 {id:'live-government-status',prompt:'Check whether the National Scholarship Portal application service is operational now.',want:true},
 {id:'live-jobs',prompt:'Find open backend engineering jobs in Hyderabad.',want:true},
 {id:'explicit-source',prompt:'Search the web for sources on protein folding.',want:true},
 {id:'explicit-verify',prompt:'Verify the claim that ArborWorks supports the Boreal-X17 model using external sources.',want:true},
 {id:'explicit-read-url',prompt:'Read https://docs.example.com/start and explain its instructions.',want:true},
 {id:'external-video',prompt:'Summarize https://www.youtube.com/watch?v=dQw4w9WgXcQ.',want:true},
 {id:'hybrid-local-live',prompt:'Summarize the attached report and verify its current prices online.',want:true,extra:{hasAttachmentEvidence:true}},
 {id:'current-sports',prompt:'Who won the cricket match today?',want:true},
 {id:'external-government-research',prompt:'Research government websites and cite sources for the licensing process.',want:true},
 {id:'attached-independent-studies',prompt:'Find peer-reviewed studies that validate the result in the attached chart.',want:true,extra:{hasAttachmentEvidence:true}},
 {id:'attached-external-citations',prompt:'Find independent citations for the claims in the attached paper.',want:true,extra:{hasAttachmentEvidence:true}},
 {id:'attached-open-positions',prompt:'Compare this attached resume with open positions at Acme.',want:true,extra:{hasAttachmentEvidence:true}},
];
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
for(const mode of ['model','unreachable','malformed'])for(const c of cases){
 it(`${mode}: ${c.id}: ${c.want?'SEARCH':'NO SEARCH'}`,async()=>{
  vi.stubEnv('WEB_SEARCH_GATE_DISABLED','');vi.stubEnv('WEB_SEARCH_LFM_DISABLED','');
  const spy=vi.fn(async()=>{
   if(mode==='unreachable')throw Error('Controlled unavailable gate model');
   return new Response(JSON.stringify({choices:[{message:{content:mode==='malformed'?'not a decision':JSON.stringify({search_required:c.want,reason:c.want?'Requires external evidence':'Self-contained/local answer',freshness:c.want?'any':'none',depth:'quick',queries:c.want?[{query:'concrete evidence lookup',intent:'general'}]:[]})}}]}),{status:200,headers:{'content-type':'application/json'}});
  });vi.stubGlobal('fetch',spy);
  const r=await runSearchGate({userPrompt:c.prompt,...c.extra});
  expect(r.decision.search_required,JSON.stringify({prompt:c.prompt,source:r.source,decision:r.decision})).toBe(c.want);
  if(!c.want)expect(r.decision.queries).toEqual([]);
 });
}
it('contextual price follow-up preserves the prior product in a deterministic query',async()=>{
 vi.stubEnv('WEB_SEARCH_GATE_DISABLED','1');
 const r=await runSearchGate({userPrompt:'What is its price now?',history:[{role:'user',content:'I want the Acme Q900 headphones from the store.'}]});
 expect(r.decision.search_required).toBe(true);
 expect(r.decision.queries.map(q=>q.query).join(' ')).toMatch(/q900/i);
});
it('a mixed-script price query preserves the requested non-Latin product and location',async()=>{
 vi.stubEnv('WEB_SEARCH_GATE_DISABLED','1');
 const r=await runSearchGate({userPrompt:'東京で牛乳 price today'});
 expect(r.decision.queries.map(q=>q.query).join(' ')).toContain('東京');
 expect(r.decision.queries.map(q=>q.query).join(' ')).toContain('牛乳');
});
