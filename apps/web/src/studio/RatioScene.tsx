import {useEffect,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

/** The drawing follows only the server-confirmed recipe scale; camera changes are view state. */
export function RatioScene({scale}:{scale:number}) {
 const mount=useRef<HTMLDivElement>(null),reset=useRef<()=>void>(()=>{});
 const [mode,setMode]=useState<'3d'|'2d'>('3d'),[failed,setFailed]=useState(false);
 useEffect(()=>{
  if(mode!=='3d'||failed||!mount.current)return;
  const host=mount.current;let renderer:THREE.WebGLRenderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{setFailed(true);return;}
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.setClearColor('#fcf9f0',0);host.append(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.1,150);camera.position.set(16,17,23);
  const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,1,0);controls.enablePan=false;controls.minDistance=23;controls.maxDistance=45;controls.maxPolarAngle=Math.PI*.46;
  scene.add(new THREE.HemisphereLight('#fffdf3','#adae97',3));const sun=new THREE.DirectionalLight('#fffaf0',3.3);sun.position.set(-10,22,8);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-18;sun.shadow.camera.right=18;sun.shadow.camera.top=18;sun.shadow.camera.bottom=-18;sun.shadow.normalBias=.025;scene.add(sun);
  const board=new THREE.Mesh(new THREE.BoxGeometry(21,.18,16),new THREE.MeshStandardMaterial({color:'#e8e4d8',roughness:1}));board.position.y=-.14;board.receiveShadow=true;scene.add(board);
  const edge=new THREE.Mesh(new THREE.BoxGeometry(21,.12,16),new THREE.MeshStandardMaterial({color:'#315d4d',roughness:1}));edge.position.y=-.3;scene.add(edge);
  const glass=new THREE.MeshPhysicalMaterial({color:'#e7efe6',transparent:true,opacity:.23,roughness:.12,metalness:0,side:THREE.DoubleSide,depthWrite:false});
  for(let row=0;row<scale;row++)for(let col=0;col<5;col++){
   const cup=new THREE.Group();cup.position.set((col-2)*3.15,0,(row-(scale-1)/2)*3.35);
   const liquid=new THREE.Mesh(new THREE.CylinderGeometry(.77,.64,1.9,48),new THREE.MeshStandardMaterial({color:col<3?'#d89d40':'#a7c0b5',roughness:.32,transparent:true,opacity:col<3?.97:.73}));liquid.position.y=1.04;liquid.castShadow=true;liquid.receiveShadow=true;cup.add(liquid);
   const wall=new THREE.Mesh(new THREE.CylinderGeometry(.88,.72,2.7,48,1,true),glass);wall.position.y=1.4;cup.add(wall);
   for(const [radius,y] of [[.88,2.75],[.72,.05]]){const rim=new THREE.Mesh(new THREE.TorusGeometry(radius,.027,8,64),new THREE.MeshStandardMaterial({color:'#96a99e',roughness:.25,transparent:true,opacity:.72}));rim.rotation.x=Math.PI/2;rim.position.y=y;cup.add(rim);}
   scene.add(cup);
  }
  const render=()=>renderer.render(scene,camera);controls.addEventListener('change',render);controls.update();
  const resize=()=>{const {width,height}=host.getBoundingClientRect();renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();render();};const observer=new ResizeObserver(resize);observer.observe(host);resize();
  reset.current=()=>{camera.position.set(16,17,23);controls.target.set(0,1,0);controls.update();render();};
  return()=>{observer.disconnect();controls.dispose();scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();const materials=Array.isArray(o.material)?o.material:[o.material];materials.forEach(m=>m.dispose());}});renderer.dispose();renderer.domElement.remove();};
 },[scale,mode,failed]);
 return <section className="recipe-scene"><div className="scene-toolbar"><span className="scene-caption">杯数一起变，配方关系呢？</span><div className="view-switch"><button aria-pressed={mode==='3d'&&!failed} onClick={()=>setMode('3d')}>立体</button><button aria-pressed={mode==='2d'||failed} onClick={()=>setMode('2d')}>平面</button></div></div>
 <div className="recipe-stage">{mode==='3d'&&!failed?<div ref={mount} className="recipe-canvas" role="img" aria-label={`${3*scale}杯纯橙汁和${2*scale}杯水，等容量杯子放在书页托盘上，可拖动观察。`}/>:<RecipeDiagram scale={scale}/>}
 <span className="recipe-label juice-label">纯橙汁<strong>{3*scale}<small>杯</small></strong></span><span className="recipe-label water-label">水<strong>{2*scale}<small>杯</small></strong></span>
 <p className="recipe-camera-note">{mode==='3d'&&!failed?'拖动模型，只改变观察角度':'同一配方的平面表达'}</p><button className="recipe-reset text-button" onClick={()=>reset.current()}>复位</button></div>
 <details className="recipe-table"><summary>用数量表看同一个配方</summary><table><thead><tr><th>配方倍数</th><th>纯橙汁</th><th>水</th><th>总量</th></tr></thead><tbody><tr><td>{scale}</td><td>{3*scale}杯</td><td>{2*scale}杯</td><td>{5*scale}杯</td></tr></tbody></table></details></section>;
}
function RecipeDiagram({scale}:{scale:number}){return <svg className="recipe-diagram" viewBox="0 0 700 420" role="img" aria-label={`纯橙汁${3*scale}杯，水${2*scale}杯`}><defs><linearGradient id="juice-fill" x1="0" x2="1"><stop stopColor="#b77c2a"/><stop offset=".5" stopColor="#e6b75c"/><stop offset="1" stopColor="#c18d35"/></linearGradient><linearGradient id="water-fill" x1="0" x2="1"><stop stopColor="#92b0a5"/><stop offset=".5" stopColor="#d2dfd5"/><stop offset="1" stopColor="#adc6ba"/></linearGradient></defs><path d="M35 370H665L640 400H60Z" fill="#e4e1d4" stroke="#b9c0ac"/>{Array.from({length:scale},(_,row)=>Array.from({length:5},(_,col)=>{const x=115+col*112,y=78+row*72;return <g key={row+'-'+col} transform={`translate(${x} ${y})`}><path d="M-30 4L-25 58Q0 72 25 58L30 4Z" fill={col<3?'url(#juice-fill)':'url(#water-fill)'} stroke="#7e998b" strokeWidth="1"/><ellipse ry="7" rx="30" cy="4" fill={col<3?'#edc374':'#dfe7dd'} stroke="#7e998b"/><path d="M-25 9L-21 52" stroke="#fffdf1" strokeWidth="3" opacity=".7"/></g>;}))}</svg>;}
