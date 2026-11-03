from pathlib import Path
import fitz,json,hashlib,re
from PIL import Image,ImageOps,ImageDraw
root=Path(__file__).resolve().parent.parent;inputs=root.parent/'content-inputs';out=root/'apps/web/public/gesp';evidence=root.parent/'delivery/gesp-r1';qs=json.loads((inputs/'gesp-objective-source-index.json').read_text())['questions'];docs={};public=[]
for q in qs:
 if q['session'] not in docs:
  assert hashlib.sha256(Path(q['source']).read_bytes()).hexdigest()==q['sourceSha256'];docs[q['session']]=fitz.open(q['source'])
 clips=[]
 for i,clip in enumerate(q['sourceClips']):
  name=q['id']+'-'+str(i)+'.png';docs[q['session']][clip['pdfPage']-1].get_pixmap(matrix=fitz.Matrix(1.5,1.5),clip=fitz.Rect(clip['box'])).save(out/name);clips.append('/gesp/'+name)
 public.append({k:q[k] for k in ['id','session','kind','number','sourceSha256','pdfPages','extractedText']}|{'clips':clips})
(root/'content/gesp/public/objective-sources.json').write_text(json.dumps(public,ensure_ascii=False,indent=2))
# Readable exact-source strips for raster-code review, first three papers.
for session in ['202303','202306','202309','202312']:
 selected=[q for q in public if q['session']==session and q['kind']=='mcq' and (q['number']>=6 or q['number']==2)]
 for group in range(0,len(selected),3):
  blocks=[]
  for q in selected[group:group+3]:
   ims=[Image.open(out/Path(x).name).convert('RGB') for x in q['clips']];w=800;scaled=[]
   for im in ims:
    nw=min(w,im.width);scaled.append(im.resize((nw,round(im.height*nw/im.width))))
   canvas=Image.new('RGB',(w,sum(x.height for x in scaled)+30),'white');ImageDraw.Draw(canvas).text((10,5),q['id'],fill='black');y=30
   for im in scaled:canvas.paste(im,(0,y));y+=im.height
   blocks.append(canvas)
  sheet=Image.new('RGB',(max(x.width for x in blocks),sum(x.height for x in blocks)+20*(len(blocks)-1)),'#ddd');y=0
  for im in blocks:sheet.paste(im,(0,y));y+=im.height+20
  sheet.save(evidence/f'source-{session}-{group//3+1}.png')
print('375 source questions,',sum(len(q['clips']) for q in public),'answer-free source clips')
programs=[]
for session,doc in docs.items():
 lines=[]
 for pn,page in enumerate(doc):
  for block in page.get_text('dict')['blocks']:
   for line in block.get('lines',[]):
    value=''.join(s['text'] for s in line['spans']);lines.append({'page':pn,'y':line['bbox'][1],'text':value})
 lines.sort(key=lambda x:(x['page'],x['y']))
 start=next(i for i,l in enumerate(lines) if '编程题' in l['text'] and '每题' in l['text'])
 anchors=[]
 for i,l in enumerate(lines[start+1:],start+1):
  m=re.match(r'^\s*([12])\.\s*[^\d]',l['text']) if session<'202309' else re.match(r'^\s*3\.([12])(?:\s+编程题|\s*$)',l['text'])
  if m:anchors.append((int(m[1]),i))
 assert [n for n,i in anchors]==[1,2],(session,anchors)
 for n,i in anchors:
  end=next((j for k,j in anchors if k==n+1),len(lines));ref=next(j for j in range(i,end) if '参考程序' in lines[j]['text']);a,z=lines[i],lines[ref];clips=[];texts=[]
  for pn in range(a['page'],z['page']+1):
   y0=max(0,a['y']-2) if pn==a['page'] else 25;y1=z['y']-3 if pn==z['page'] else doc[pn].rect.height-30
   if y1<=y0:continue
   box=fitz.Rect(35,y0,doc[pn].rect.width-30,y1);name=f'gesp2.{session}.p{n:02}-{len(clips)}.png';doc[pn].get_pixmap(matrix=fitz.Matrix(1.5,1.5),clip=box).save(out/name);clips.append('/gesp/'+name);texts.append(doc[pn].get_text(clip=box))
  title=lines[i]['text'] if session<'202309' else next((l['text'] for l in lines[i:ref] if '试题名称' in l['text']),next((l['text'] for l in lines[i:ref] if re.match(r'3\.[12]\.1\s',l['text'])),''))
  reference='\n'.join(l['text'] for l in lines[ref+1:end] if not re.match(r'^\s*\d+\s*$',l['text']) and not re.search(r'页|^\s*\d+ /|^\s*编程题\s*[12]\s*$',l['text']))
  programs.append({'id':f'gesp2.{session}.p{n:02}','session':session,'kind':'program','number':n,'title':title,'sourceSha256':next(q['sourceSha256'] for q in public if q['session']==session),'pdfPages':list(range(a['page']+1,z['page']+2)),'clips':clips,'extractedText':'\n'.join(texts),'sourceReference':reference})
(root/'content/gesp/private/program-source-reference.json').write_text(json.dumps(programs,ensure_ascii=False,indent=2))
(root/'content/gesp/public/program-sources.json').write_text(json.dumps([{k:v for k,v in p.items() if k!='sourceReference'} for p in programs],ensure_ascii=False,indent=2))
print('30 programming prompts separated from reference code')
