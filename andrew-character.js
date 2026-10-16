/* Ask Andrew sprite engine — vanilla JS, canvas rendering, feet-anchored frames.
   Sections: sprite config, state machine, movement/physics, drag, chat. */
(async function () {
'use strict';
// 1. SPRITE CONFIG. All frame counts and durations are read from sprites.json.
const config = await fetch('assets/sprites.json').then(r => { if (!r.ok) throw Error('Missing assets/sprites.json'); return r.json(); });
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const stage = document.getElementById('andrew-stage');
const trigger = document.getElementById('ask-toggle');
const panel = document.getElementById('ask-panel');
const closeButton = document.getElementById('ask-close');
const form = document.getElementById('ask-form');
const history = document.getElementById('ask-history');
const input = document.getElementById('ask-input');
const legacySprite = document.getElementById('andrew-character');
const legacyPanelSprite = document.getElementById('andrew-panel-character');
const SIZE=64, SCALE=2, PIXELS=SIZE*SCALE, GROUND=8;
const actionKey={idle:'idle',walking:'walking',sleeping:'sleeping',hovering:'hovering',clicked:'clicked',projectOpened:'project_opened',lookAround:'look_around',thinking:'thinking',talking:'talking',cheer:'cheer',listening:'listening',dragging:'held',falling:'falling',landed:'falling'};
const loaded={};
await Promise.all(Object.entries(config).map(async ([name,item])=>{
 const im=new Image(); im.src=item.url;
 try { await im.decode(); loaded[name]=im; } catch(err){ console.warn('Sprite unavailable, falling back to idle:',name); }
}));
if(!loaded.idle)throw Error('Idle sprite missing');
function entry(state){let key=actionKey[state]||state; if(!loaded[key]||!config[key])key='idle';return {key,...config[key],img:loaded[key]};}
function canvas(id,parent){const c=document.createElement('canvas');c.id=id;c.width=PIXELS;c.height=PIXELS;c.style.cssText='width:128px;height:128px;display:block;image-rendering:pixelated;pointer-events:none';parent.replaceWith(c);return c;}
const mainCanvas=canvas('andrew-canvas',legacySprite);
const chatCanvas=canvas('andrew-chat-canvas',legacyPanelSprite);
chatCanvas.style.width='48px';chatCanvas.style.height='48px';
const mainCtx=mainCanvas.getContext('2d');const chatCtx=chatCanvas.getContext('2d');
mainCtx.imageSmoothingEnabled=false;chatCtx.imageSmoothingEnabled=false;
function draw(ctx,state,index){
 const item=entry(state);const frame=Math.max(0,Math.min(item.frames-1,index));
 const {frameWidth:w,frameHeight:h}=item;
 ctx.clearRect(0,0,PIXELS,PIXELS);
 // Normalize older large source frames into the same 64px viewport.
 const factor=Math.min(56/w,58/h);
 const dw=Math.round(w*factor),dh=Math.round(h*factor);
 const dx=Math.round((SIZE-dw)/2),dy=SIZE-2-dh;
 ctx.drawImage(item.img,frame*w,0,w,h,dx*SCALE,dy*SCALE,dw*SCALE,dh*SCALE);
}
// 2. STATE MACHINE. Interruptible ambient states; chat locks during reply.
const ambient=new Set(['idle','walking','sleeping','lookAround','hovering','projectOpened','clicked','cheer','landed']);
const transitions={
 idle:['walking','sleeping','lookAround','hovering','clicked','projectOpened','listening','thinking','cheer'],
 walking:['idle','hovering','clicked','projectOpened','listening'],
 sleeping:['idle','hovering','clicked','listening'],
 lookAround:['idle','hovering','clicked','projectOpened','listening'],
 hovering:['idle','clicked','listening'],
 clicked:['idle','listening','thinking'],
 projectOpened:['idle','listening','thinking'],
 listening:['idle','thinking','cheer'],
 thinking:['talking','idle'], talking:['cheer','idle'],
 cheer:['idle','listening'],dragging:['falling'],falling:['landed'],landed:['idle']
};
let state='idle',frame=0,elapsed=0,sequenceDone=false,freezeUntil=0;
let lastInput=performance.now(),nextLook=performance.now()+9000,nextWave=performance.now()+10000;
let x=Math.max(8,innerWidth-150),y=GROUND,ground=GROUND,velocityY=0;
let walkTarget=x,walkDirection=1,walkUntil=0,projectCard=null;
let hovering=false,dragging=false,pointerId=null,startPointer=null,dragMoved=false;
let busy=false,firstMessage=false,last=performance.now(),frameCounter=0;
const sleepDelay=30000;
function setState(next,opts={}){
 if(next===state)return true;
 if(!Object.prototype.hasOwnProperty.call(transitions,next))return false;
 if(state==='dragging'||state==='falling') {if(next!=='falling'&&next!=='landed')return false;}
 if((state==='thinking'||state==='talking') && !opts.internal && next!=='dragging')return false;
 if(!opts.force && !(transitions[state]||[]).includes(next) && next!=='dragging')return false;
 state=next;frame=0;elapsed=0;sequenceDone=false;freezeUntil=0;stage.dataset.state=next;
 return true;
}
const oneShots=new Set(['clicked','projectOpened','cheer','lookAround','landed']);
function currentSequence(){
 const n=entry(state).frames;
 if(state==='idle'&&n>=3)return [0,1,2,1,0];
 if(state==='sleeping'&&n>2)return Array.from({length:n-2},(_,i)=>i+2);
 return Array.from({length:n},(_,i)=>i);
}
function tickFrames(dt,now){
 if(reduced.matches){frame=0;return;}
 const info=entry(state);const seq=currentSequence();
 const duration=info.duration||180;
 elapsed+=dt;
 while(elapsed>=duration){
  elapsed-=duration;
  if(frame<seq.length-1)frame++;
  else if(oneShots.has(state)){frame=seq.length-1;sequenceDone=true;break;}
  else if(state==='hovering'){frame=seq.length-1;break;}
  else frame=0;
 }
 if(sequenceDone){
  if(!freezeUntil)freezeUntil=now+(state==='projectOpened'?1000:state==='cheer'?300:160);
  if(now>=freezeUntil){
   if(state==='clicked'){openPanel(true);setState('listening',{force:true});}
   else if(state==='landed'){setState('idle',{force:true});}
   else setState('idle',{force:true});
  }
 }
}
function activeFrame(){const seq=currentSequence();return seq[Math.min(frame,seq.length-1)]||0;}
// 3. MOVEMENT + PHYSICS. All positions in CSS pixels, feet at ground.
function viewportX(value){return Math.max(0,Math.min(innerWidth-PIXELS,Math.round(value)));}
function walkTo(target,card=null){
 if(reduced.matches)return;
 if(!ambient.has(state)||state==='sleeping')return;
 walkTarget=viewportX(target);projectCard=card;
 walkDirection=walkTarget<x? -1:1;
 if(Math.abs(walkTarget-x)>4)setState('walking',{force:true});
 else if(card)setState('projectOpened',{force:true});
}
function tickMotion(dt,now){
 if(state==='dragging')return;
 if(state==='falling'){
  velocityY=Math.min(19,velocityY+0.8*(dt/16.67));
  y=Math.max(ground,y-velocityY*(dt/16.67));
  if(y<=ground){y=ground;velocityY=0;setState('landed',{force:true});}
  return;
 }
 if(state==='walking'){
  const dx=walkTarget-x,step=Math.sign(dx)*Math.min(Math.abs(dx),0.11*dt);
  x=viewportX(x+step);walkDirection=step<0?-1:1;
  if(Math.abs(walkTarget-x)<2){if(projectCard){projectCard=null;setState('projectOpened',{force:true});}else setState('idle',{force:true});}
 }
 if(state==='idle'&&!panel.hidden)return;
 if(state==='idle'&&now-lastInput>=sleepDelay){setState('sleeping');return;}
 if(state==='idle'&&now>=nextLook){nextLook=now+8000+Math.random()*7000;setState('lookAround');return;}
 if(state==='idle'&&now>=nextWave){nextWave=now+10000;setState('hovering');freezeUntil=now+600;return;}
 if(state==='idle'&&now>=walkUntil){walkUntil=now+6000+Math.random()*6000;walkTo(10+Math.random()*(innerWidth-PIXELS-20));}
 if(state==='hovering'&&!hovering&&freezeUntil&&now>freezeUntil)setState('idle',{force:true});
}
function paint(){
 // Suppress the pointing/hover gesture only; preserve walking and other animations.
 const noPointing=(state==='hovering'||state==='projectOpened');
 const visual=(reduced.matches||noPointing)?'idle':state;
 const idx=(reduced.matches||noPointing)?0:activeFrame();
 draw(mainCtx,visual,idx);
 const panelState=panel.hidden?'idle':(busy?state:'listening');
 draw(chatCtx,panelState,panelState===state?idx:0);
 stage.style.left=Math.round(x)+'px';stage.style.bottom=Math.round(y)+'px';
 mainCanvas.style.transform=`scaleX(${walkDirection})`;
 if(new URLSearchParams(location.search).has('debug')){
  mainCanvas.style.outline='1px dashed #f472b6';
  stage.style.background='linear-gradient(transparent calc(100% - 2px),#34d399 calc(100% - 2px))';
 }
}
function loop(now){const dt=Math.min(70,now-last);last=now;
 tickFrames(dt,now);tickMotion(dt,now);paint();requestAnimationFrame(loop);
}
function activity(){lastInput=performance.now();if(state==='sleeping')setState('idle',{force:true});}
addEventListener('pointermove',activity,{passive:true});addEventListener('keydown',activity);
addEventListener('resize',()=>{x=viewportX(x);if(state!=='dragging'&&state!=='falling')y=ground;});
// 4. DRAG. Pointer capture, gravity, and strict click-vs-drag separation.
trigger.style.touchAction='none';trigger.style.userSelect='none';trigger.style.cursor='grab';
trigger.addEventListener('pointerdown',e=>{
 if(e.button!==0)return;
 pointerId=e.pointerId;startPointer={x:e.clientX,y:e.clientY,originX:x,originY:y};dragMoved=false;
 trigger.setPointerCapture(e.pointerId);activity();
});
trigger.addEventListener('pointermove',e=>{
 if(e.pointerId!==pointerId||!startPointer)return;
 const dx=e.clientX-startPointer.x,dy=e.clientY-startPointer.y;
 if(Math.hypot(dx,dy)<5&&!dragMoved)return;
 if(!dragMoved){dragMoved=true;dragging=true;setState('dragging',{force:true});trigger.style.cursor='grabbing';}
 x=viewportX(startPointer.originX+dx);
 // bottom coordinate increases when character moves up
 y=Math.max(ground,Math.min(innerHeight-PIXELS,startPointer.originY-dy));
});
function release(e){
 if(pointerId!==e.pointerId)return;
 const wasDrag=dragMoved;
 pointerId=null;startPointer=null;dragMoved=false;dragging=false;trigger.style.cursor='grab';activity();
 if(wasDrag){velocityY=0;setState('falling',{force:true});return;}
 if(panel.hidden){if(setState('clicked',{force:true})&&reduced.matches){openPanel(true);setState('listening',{force:true});}}
 else {openPanel(false);setState('idle',{force:true});}
}
trigger.addEventListener('pointerup',release);
trigger.addEventListener('pointercancel',e=>{if(e.pointerId===pointerId){pointerId=null;startPointer=null;dragMoved=false;dragging=false;velocityY=0;setState('falling',{force:true});}});
trigger.addEventListener('pointerenter',()=>{hovering=true;if(ambient.has(state)&&state!=='sleeping')setState('hovering',{force:true});});
trigger.addEventListener('pointerleave',()=>{hovering=false;if(state==='hovering')setState('idle',{force:true});});
// Keyboard accessibility: native button Enter/Space fires click without pointerup.
trigger.addEventListener('click',e=>{if(e.detail!==0)return;if(panel.hidden){setState('clicked',{force:true});if(reduced.matches){openPanel(true);setState('listening',{force:true});}}else openPanel(false);});
function openPanel(open){panel.hidden=!open;trigger.setAttribute('aria-expanded',String(open));if(open){input.focus();if(state!=='thinking'&&state!=='talking')setState('listening',{force:true});}else {trigger.focus();if(!busy)setState('idle',{force:true});}}
closeButton.addEventListener('click',()=>openPanel(false));
// Project hover: approach nearest horizontal edge; opening: reaction.
document.querySelectorAll('.project-card').forEach(card=>{
 card.addEventListener('pointerenter',()=>{
  if(innerWidth<700||!panel.hidden)return;
  const r=card.getBoundingClientRect();
  if(r.bottom<innerHeight-PIXELS)walkTo(r.left>x? r.left-PIXELS:r.right+8,card);
 });
 card.addEventListener('click',()=>{if(ambient.has(state)){
  const r=card.getBoundingClientRect();walkTo(r.left>x?r.left-PIXELS:r.right+8,card);
  if(reduced.matches)setState('projectOpened',{force:true});
 }});
});
// 5. CHAT INTEGRATION. Preset answers; replace requestReply with a secure API.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function requestReply(question){
 // For a real LLM: POST to your own secured backend, never expose API keys here.
 await pause(350);
 return typeof respond==='function'?respond(question):'Ask about Andrew’s projects, skills or contact details!';
}
function bubble(kind){const d=document.createElement('div');d.className='chat-bubble '+kind;history.appendChild(d);history.scrollTop=history.scrollHeight;return d;}
async function talk(text){
 setState('talking',{force:true});const el=bubble('bot');
 if(reduced.matches){el.textContent=text;return;}
 for(const ch of text){el.textContent+=ch;history.scrollTop=history.scrollHeight;
  await pause(/[.!?]/.test(ch)?230:/[,;:]/.test(ch)?110:24);
 }
}
async function ask(question){const q=question.trim();if(!q||busy)return;busy=true;activity();
 bubble('user').textContent=q;
 if(!firstMessage){firstMessage=true;setState('cheer',{force:true});await pause(reduced.matches?0:500);}
 setState('thinking',{force:true});let answer;
 try{answer=await requestReply(q);}catch(err){answer='Sorry, something went wrong. Please try again.';}
 await talk(String(answer));setState('cheer',{force:true});await pause(reduced.matches?0:450);
 setState('idle',{force:true});busy=false;
}
form.addEventListener('submit',e=>{e.preventDefault();const q=input.value;input.value='';ask(q);});
document.querySelectorAll('[data-question]').forEach(b=>b.addEventListener('click',()=>ask(b.dataset.question)));
input.addEventListener('input',()=>{if(!busy&&state!=='listening')setState('listening',{force:true});});
window.andrew={get state(){return state;},setState,ask,reply:talk,open:()=>openPanel(true),close:()=>openPanel(false)};
if(reduced.matches){walkUntil=Infinity;nextLook=Infinity;nextWave=Infinity;}
paint();requestAnimationFrame(loop);
})();
