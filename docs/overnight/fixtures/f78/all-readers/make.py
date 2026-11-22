import json,re,zipfile,gzip,bz2,lzma,tarfile,io,struct,subprocess,os
from pathlib import Path
from PIL import Image,ImageDraw
R=Path('D:/Projects/WebUI/WebUI'); P=Path('../review-complex-1121'); Q=Path('../review-docs'); src=(R/'lib/files/extensions.ts').read_text().split('const EXT_CATEGORY:')[1].split('};')[0]; cats=dict(re.findall(r'["]?(\w+)["]?: "(text|image|audio|video|archive|office|legacy|notebook|rtf|pdf)"',src));print('registry',len(cats));out={}
def add(f,cat,expected):out[str(f)]={'category':cat,'expected':expected}
tags=['ALPHA-249','Δοκιμή','東京','FINAL-681']
def txt(e):
 a,b,c,d=tags
 if e in ['csv','tsv']:
  sep=',' if e=='csv' else '\t';return sep.join(['id','location','note'])+'\r\n'+sep.join([a,b,'"'+c+sep+'two\r\nlines"'])+'\r\n'+sep.join([d,'7','end'])
 if e in ['json','jsonl']:return (json.dumps({'start':a,'place':b,'nested':[{'name':c,'end':d}]},ensure_ascii=False) if e=='json' else '\r\n'.join(json.dumps({'row':i,'name':t},ensure_ascii=False) for i,t in enumerate(tags)))
 if e in ['xml','html','htm','svg','vue','svelte','astro','jsx','tsx']:return (f'<svg xmlns="http://www.w3.org/2000/svg"><g><text>{a} {b}</text><text>{c} {d}</text></g></svg>' if e=='svg' else f'<section data-code="{a}"><div>{b}<span>{c}</span></div><footer>{d}</footer></section>')
 if e in ['diff','patch']:return f'--- a/status\n+++ b/status\n@@ -1,2 +1,2 @@\n-{a} {b}\n+{c} {d}\n stable\n'
 return '\r\n'.join([f'# phase = "{a}"',f'  local_name = "{b}"',f'  city = "{c}"',f'# retired: 793; active: 349',f'  checksum = "{d}"'])
for j,e in enumerate([k for k,v in cats.items() if v=='text']+['Dockerfile','Makefile','.env']):
 f=e if e in ['Dockerfile','Makefile','.env'] else 'sample.'+e
 s=txt(e); enc=['utf-8','utf-16','utf-8-sig','utf-32'][j%4];Path(f).write_bytes(s.encode(enc));add(f,'text',tags+['retired: 793; active: 349'] if 'retired:' in s else tags)
def copy(f,src,cat,expect):Path(f).write_bytes(Path(src).read_bytes());add(f,cat,expect)
for f,src,cat,expect in [('sample.docx',Q/'policy.docx','office',['307 seats','73 tonnes','17 June 2031']),('sample.pptx',Q/'deck.pptx','office',['61 litres','83','42']),('sample.xlsx',P/'book.xlsx','office',['Mistral settlement','Heliotrope terminal']),('sample.epub',Q/'manual.epub','office',['Inventory the red crate','341 volts']),('sample.ipynb',Q/'results.ipynb','notebook',['0.72','0.639','amber_partition']),('sample.rtf',Q/'sample.rtf','rtf',['Visible price 42','Café']),('sample.pdf',P/'mixed-tagged.pdf','pdf',['4,18,25,000'])]:copy(f,src,cat,expect)
for e in ['odt','ods','odp']:copy('sample.'+e,Q/('structured.'+e),'office',{'ods':['Cash','178','Debt'],'odp':['Intake','Return','76'],'odt':['37 bars','Shutdown']}[e])
with zipfile.ZipFile('sample.xlsx') as a,zipfile.ZipFile('sample.xlsm','w') as b:
 for i in a.infolist():
  data=a.read(i)
  if i.filename=='[Content_Types].xml':data=data.replace(b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',b'application/vnd.ms-excel.sheet.macroEnabled.main+xml')
  b.writestr(i,data)
add('sample.xlsm','office',['Mistral settlement','Heliotrope terminal'])
Path('sample.mat').write_bytes(struct.pack('<5i',0,2,2,0,7)+b'yields\0'+struct.pack('<4d',12.25,98.75,63.5,440.125));add('sample.mat','legacy',['yields','440.125','98.75'])
for e in ['doc','xls','ppt']:copy('smoke.'+e,R/'tests/fixtures'/('fixture-legacy.'+e),'legacy',['READABLE-MARKER-'+e.upper()])
files={'current/summary.csv':b'currency,total\nCAD,66719\n','prior/summary.csv':b'currency,total\nCAD,45103\n','notes/report.txt':'résumé Tokyo 918'.encode()}
for n,d in files.items():p=Path(n);p.parent.mkdir(exist_ok=True);p.write_bytes(d)
for e in ['zip','tar','tgz','gz','bz2','xz','7z','rar']:
 f='audit.'+e if e not in ['gz','bz2','xz'] else 'summary.csv.'+e
 if e=='zip':
  with zipfile.ZipFile(f,'w',zipfile.ZIP_DEFLATED) as z:
   for n,d in files.items():z.writestr(n,d)
 elif e in ['tar','tgz']:
  with tarfile.open(f,'w:gz' if e=='tgz' else 'w') as z:
   for n in files:z.add(n)
 elif e in ['7z','rar']:
  prog=R/'node_modules/7zip-bin/win/x64/7za.exe' if e=='7z' else Path('C:/Program Files/WinRAR/Rar.exe')
  subprocess.run([str(prog),'a',f,*files],capture_output=True,check=True)
 else:Path(f).write_bytes({'gz':gzip,'xz':lzma,'bz2':bz2}[e].compress(files['current/summary.csv']))
 add(f,'archive',['66719'] if e in ['gz','xz','bz2'] else ['66719','45103','918'])
ff=str(R/'node_modules/ffmpeg-static/ffmpeg.exe')
def run(args):return subprocess.run([ff,'-y','-loglevel','error',*args],capture_output=True).returncode==0
im=Image.new('RGB',(640,360),'white');g=ImageDraw.Draw(im);g.rectangle((0,0,310,175),fill=(210,10,10));g.rectangle((326,185,639,359),fill=(10,25,213));g.text((350,30),'ROW 39  /  CUT 804',fill='black'); im2=im.transpose(Image.Transpose.ROTATE_180)
for e in [k for k,v in cats.items() if v=='image']:
 f='panel.'+e
 try:
  if e in ['gif','tiff','tif','webp']:im.save(f,save_all=True,append_images=[im2],duration=600,loop=0)
  elif e=='ico':im.resize((256,256)).save(f,sizes=[(32,32),(128,128),(256,256)])
  else:im.save(f)
  add(f,'image',[])
 except Exception:pass
for e in [k for k,v in cats.items() if v=='audio']:
 f='overlap.'+e
 if run(['-i',str(P/'overlap.wav'),'-ar','44100',f]):add(f,'audio',['Monday','47','Toronto'])
for e in [k for k,v in cats.items() if v=='video']:
 f='dual.'+e
 opts=['-c:v','mpeg4','-c:a','aac'] if e in ['avi','3gp','mp4','mov','mkv'] else ['-c:v','mpeg2video','-c:a','mp2'] if e in ['mpeg','mpg'] else ['-c:v','libvpx','-c:a','libopus']
 if run(['-ss','53','-i',str(P/'mixed-av.mp4'),'-t','16','-vf','scale=352:288,fps=25','-threads','2',*opts,f]):add(f,'video',['47'])
Path('plan.json').write_text(json.dumps(out,ensure_ascii=False),encoding='utf-8');print('generated',len(out),'absent',set(cats)-{f.split('.')[-1] for f in out})
