import assert from'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{CompilerService}from'../../workers/cpp/compiler.mjs';
const lock=JSON.parse(readFileSync('workers/cpp/worker-lock.json')),c=new CompilerService(lock),out='../delivery/gesp-r1/semantic-runtime.json';await c.verify();const proofs=[];
const probes=[
 ['202509-tf04-comma-assignment','int x=7,y=8,z=9; x,y,z=5,10,15; int result=x<y<z; cout<<x<<" "<<y<<" "<<z<<" "<<result;','7 8 5 1'],
 ['202312-mcq11-two-square-predicates','int diff=0;for(int i=1;i<=100;i++){bool b=int(sqrt(i))==sqrt(i);bool cc=int(sqrt(i))*int(sqrt(i))==i;if(b!=cc)diff++;}cout<<diff;','0'],
 ['202312-mcq15-C-boundary','int N=6;for(int i=2;i<N/2;i++)if(!(N%(i-1))&&!(N%i))cout<<"("<<i-1<<","<<i<<")";','(1,2)'],
 ['202312-mcq15-D-boundary','int N=2;int count=0;for(int i=1;i<N/2;i++)if(!(N%i)&&!(N%(i+1)))count++;cout<<count;','0'],
 ['202403-mcq10-two-terminating-solutions','for(int n:{1,2,12,13,2024,2025,999}){bool a=true,b=true;int x=n,y=n;while(x){if(x%2){a=false;break;}else x/=10;}while(y){if(y%2){b=false;y/=10;}else y/=10;}cout<<(a==b);} ','1111111'],
 ['202509-tf03-output-vs-reason','int a=5;cout<<(a<10 and 20);','1'],
 ['202512-tf07-integer-range','cout<<(10000000000LL>numeric_limits<int>::max());','1'],
 ['202606-tf09-final-place-overflow','cout<<(10000000000LL>numeric_limits<int>::max());','1'],
 ['202412-mcq11-print-literal','print("%c",\'\\n\');',null],
];
try{for(const[id,body,expected]of probes){const source='#include <bits/stdc++.h>\nusing namespace std;int main(){'+body+'}\n';let run=c.submit({requestId:'gesp-semantics-'+id,source,stdin:''});while(!run.terminal){await new Promise(r=>setTimeout(r,100));run=c.read(run.id);}if(expected===null)assert.equal(run.state,'COMPILE_ERROR');else{assert.equal(run.state,'OK');assert.equal(run.result.execution.stdout,expected);}proofs.push({id,source,workerJobId:run.id,sourceHash:run.sourceHash,inputHash:run.inputHash,status:run.state,stdout:run.result?.execution?.stdout??'',stderr:run.result?.compilation?.stderr??''});}
 writeFileSync(out,JSON.stringify({status:'PASS',compilerContractId:lock.compilerContractId,imageId:lock.imageId,proofs,note:'Initialized comma example proves only z is assigned. It does not execute or invent a guaranteed result for uninitialized x/y; that case is explained as missing preconditions.'},null,2));console.log('9 semantic/source-boundary proofs PASS');}finally{await c.close();}
