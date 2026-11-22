from pathlib import Path
import json,shutil,zipfile,tarfile,io
p=Path('native');p.mkdir(exist_ok=True);a={}
def add(f,s,keys):
 (p/f).write_text(s,encoding='utf-8');a['native/'+f]={'category':'text','expected':keys}
def line(f,s):add(f,s,['active','retired','917','413'])
core='const int retired = 917;\nconst int active = 413;\n'
native={}
for e in 'c cc cpp h hpp'.split():native[e]='#ifndef POLICIES_H\n#define POLICIES_H\nenum Limits { retired = 917, active = 413 };\n#endif\n'
for e in 'js jsx ts tsx'.split():native[e]='export const settings = { retired: 917, active: 413 };\nexport function limit(key) { return settings[key] ?? 0; }\n'
for e in 'py rb r m'.split():native[e]={'py':'def limits():\n    return {"retired": 917, "active": 413}\n','rb':'def limits\n  { retired: 917, active: 413 }\nend\n','r':'limits <- list(retired = 917, active = 413)\n','m':'limits = struct("retired", 917, "active", 413);\n'}[e]
native.update(java='class Limits { static final int retired = 917, active = 413; }',cs='class Limits { public const int retired = 917, active = 413; }',go='package limits\nconst (\n retired = 917\n active = 413\n)\n',rs='pub const RETIRED:i32=917;\npub const ACTIVE:i32=413; // retired and active',php='<?php $limits = ["retired" => 917, "active" => 413];',swift='let limits = ["retired": 917, "active": 413]',kt='val limits = mapOf("retired" to 917, "active" to 413)',scala='object Limits { val limits = Map("retired" -> 917, "active" -> 413) }',ps1='$limits = @{ retired = 917; active = 413 }',sql="WITH limits(kind, units) AS (VALUES ('retired',917),('active',413)) SELECT units FROM limits WHERE kind='active';",tex=r'\documentclass{article}\begin{document}retired $917$; active $413$.\end{document}',bib='@misc{active,title={Active 413},note={retired 917}}',proto='syntax = "proto3"; message Limit { int32 active = 413; int32 retired = 917; }',graphql='type Limits { active: Int retired: Int }\n# current = 413, former = 917')
native['kts']=native['kt'];native['gql']=native['graphql']
for e in 'sh bash zsh env conf cfg properties'.split():native[e]='retired=917\nactive=413\n'
for e in 'bat cmd'.split():native[e]='@echo off\r\nset "retired=917"\r\nset "active=413"\r\n'
for e in 'vue svelte astro'.split():native[e]='<template><div data-active="413" data-retired="917">Limits</div></template>' if e=='vue' else '<div data-active="413" data-retired="917">Limits</div>'
for e in 'tf hcl'.split():native[e]='locals {\n limits = { retired = 917, active = 413 }\n}'
for e in 'yaml yml'.split():native[e]='policy:\n  retired: 917\n  active: 413\n'
native.update(toml='[limits]\nretired = 917\nactive = 413',ini='[limits]\nretired=917\nactive=413',txt='Status history\nretired: 917\nactive: 413',log='2025-05-01 state=retired count=917\n2025-05-02 state=active count=413',md='# Limits\n|state|count|\n|---|---:|\n|retired|917|\n|active|413|',json='{"prior":{"retired":917},"now":[{"active":413}]}',jsonl='{"retired":917}\n{"active":413}\n',xml='<ledger><entry kind="retired">917</entry><entry kind="active">413</entry></ledger>',csv='id,kind,total,note\r\n1,retired,917,"one,two"\r\n2,active,413,"first\r\nsecond"',tsv='id\tkind\ttotal\n1\tretired\t917\n2\tactive\t413',diff='--- a/limits\n+++ b/limits\n@@ -1 +1 @@\n-retired=917\n+active=413',html='<html><body><table><tr><td>retired</td><td>917</td></tr><tr><td>active</td><td>413</td></tr></table></body></html>',svg='<svg xmlns="http://www.w3.org/2000/svg"><text x="4" y="15">retired 917</text><text x="4" y="35">active 413</text></svg>',dockerfile='FROM scratch\nLABEL retired="917" active="413"',makefile='retired := 917\nactive := 413\nall:\n\t@echo $(active)')
native['patch']=native['diff'];native['htm']=native['html']
for e,s in native.items():line('policy.'+e,s)
for f,e in [('Dockerfile','dockerfile'),('Makefile','makefile'),('.env','env')]:line(f,native[e])
for old in ['sample.ipynb','audit.tar']:
 pass
j=json.loads(Path('sample.ipynb').read_text());j['cells'][1]['outputs'][1]['data']['application/json']['exact_id']=9007199254740993
(p/'exact.ipynb').write_text(json.dumps(j));a['native/exact.ipynb']={'category':'notebook','expected':['9007199254740993','0.639']}
for c in ['xz','bz2']:
 with tarfile.open(p/('combined.tar.'+c),'w:'+c) as tar:
  for f in ['current/summary.csv','prior/summary.csv']:tar.add(f)
 a['native/combined.tar.'+c]={'category':'archive','expected':['current/summary.csv','prior/summary.csv','66719','45103']}
Path('native-plan.json').write_text(json.dumps(a));print('syntax cases',len(native),'rows',len(a))
