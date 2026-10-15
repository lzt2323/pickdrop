// Spatial continuity; transitions retarget from their current value on interruption.
(()=>{
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');let keyboard=false;
 document.addEventListener('keydown',()=>keyboard=true,true);
 document.addEventListener('pointerdown',()=>keyboard=false,true);
 const immediate=()=>reduce.matches||keyboard;
 const app=document.getElementById('app'),edge=document.getElementById('expand');
 let collapsed=false,timer,epoch=0;
 function windowState(next){
  const version=++epoch;clearTimeout(timer);collapsed=next;
  const instant=immediate();app.classList.toggle('motion-instant',instant);edge.classList.toggle('motion-instant',instant);
  // Keep both endpoints mounted while moving, so a reversal never restarts at zero.
  app.hidden=false;edge.hidden=false;
  if(!app.dataset.motionReady){app.dataset.motionReady='true';edge.classList.add('motion-dormant');void edge.offsetWidth;}
  void app.offsetWidth;
  app.style.transformOrigin='right center';
  app.classList.toggle('motion-collapsed',next);edge.classList.toggle('motion-dormant',!next);
  app.inert=next;edge.inert=!next;app.setAttribute('aria-hidden',String(next));edge.setAttribute('aria-hidden',String(!next));
  document.body.dataset.windowState=next?'collapsed':'expanded';
  (next?edge:document.getElementById('collapse')).focus({preventScroll:true});
  const finish=()=>{if(version!==epoch)return;app.hidden=collapsed;edge.hidden=!collapsed;};
  if(instant)finish();else timer=setTimeout(finish,250);
 }
 const panel=document.getElementById('dialog');let panelTimer, panelEpoch=0;
 function openPanel(){++panelEpoch;clearTimeout(panelTimer);panel.classList.toggle('motion-instant',immediate());
  if(!panel.open){panel.classList.add('motion-dismissed');panel.showModal();void panel.offsetWidth;}
  panel.classList.remove('motion-dismissed');
 }
 function closePanel(done){const version=++panelEpoch;clearTimeout(panelTimer);panel.classList.toggle('motion-instant',immediate());panel.classList.add('motion-dismissed');
  const finish=()=>{if(version!==panelEpoch)return;panel.close();done?.();};
  if(immediate())finish();else panelTimer=setTimeout(finish,180);
 }
 reduce.addEventListener('change',()=>{if(reduce.matches){if(app?.dataset.motionReady)windowState(collapsed);if(panel?.open&&panel.classList.contains('motion-dismissed')){clearTimeout(panelTimer);panel.close();}}});
 window.pawMotion={windowState,openPanel,closePanel};
})();
