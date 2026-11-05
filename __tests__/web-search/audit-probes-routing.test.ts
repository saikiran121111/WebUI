/**
 * VENDORED verbatim from the independent audit workspace fixture
 * audit-nov5-probes-routing.test.ts (audit baseline 60fe172). Zero
 * deviations — the file needs no path artifacts removed. Arms span
 * WS01 (locative place never a site destination — locked at 61951d0),
 * WS04 (follow-up query retains the actual research subject) and
 * WS13 (search-tracking variation srsltid shares a canonical identity).
 */
import {it,expect,vi,afterEach} from 'vitest';
import {deriveTaskScope,routesToBrowserTurn} from '@/lib/decision/task-scope';
import {runSearchGate} from '@/lib/web-search/search-gate';
import {normalizeUrl} from '@/lib/web-search/metasearch';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
for(const [prompt,place] of [
 ['Find open backend engineering jobs in Hyderabad.','Hyderabad'],
 ['Find backend engineering jobs in Hyderabad.','Hyderabad'],
 ['Find open scholarships in India.','India'],
 ['Search available jobs in Hyderabad.','Hyderabad'],
])it('location is not a website destination: '+prompt,()=>{
 const scope=deriveTaskScope(prompt);
 expect(scope.targets.map(t=>t.phrase.toLowerCase()),JSON.stringify(scope)).not.toContain(place.toLowerCase());
 expect(routesToBrowserTurn(scope)).toBe(false);
});
it('control: explicit browser navigation retains its operational route',()=>{
 const scope=deriveTaskScope('Open Zepto website');expect(routesToBrowserTurn(scope)).toBe(true);expect(scope.targets[0].phrase).toMatch(/zepto/i);
});
it('control: actual job-site URL retains source affinity',()=>{
 const scope=deriveTaskScope('Find backend engineering jobs on careers.example.com');expect(scope.targets.some(t=>t.host==='example.com')).toBe(true);expect(routesToBrowserTurn(scope)).toBe(false);
});
for(const prompt of [
 'Take your time do the through search and give me models because you did not mentioned the details of the models that is being used',
 'Search again and verify the supported models.',
])it('follow-up query retains the actual research subject: '+prompt,async()=>{
 vi.stubEnv('WEB_SEARCH_GATE_DISABLED','');vi.stubEnv('WEB_SEARCH_LFM_DISABLED','');vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('controlled unavailable gate');}));const r=await runSearchGate({userPrompt:prompt,history:[{role:'user',content:'Tell me about the ArborWorks Boreal platform from its official documentation.'}]});
 expect(r.decision.search_required).toBe(true);expect(r.decision.queries.map(q=>q.query).join(' '),JSON.stringify(r.decision)).toMatch(/ArborWorks|Boreal/i);
});
it('search-tracking variations share a canonical identity',()=>{
 expect(normalizeUrl('https://www.example.com/product/A?srsltid=one')).toBe(normalizeUrl('https://www.example.com/product/A?srsltid=two'));
});
it('control: distinct product variants keep distinct canonical identities',()=>{
 expect(normalizeUrl('https://www.example.com/product/A?variant=500ml')).not.toBe(normalizeUrl('https://www.example.com/product/A?variant=1l'));
});
