/** Synthetic language probes with the installed local compiler, not the product compiler worker. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),out='.p0-checks',compiler=process.env.CXX??'g++',log=[];
mkdirSync(resolve(root,out),{recursive:true});
function run(command,args,input){const r=spawnSync(command,args,{cwd:root,input,encoding:'utf8',timeout:30000});log.push('$ '+[command,...args].join(' ')+(input?' [synthetic stdin '+input.trim()+']':'')+'\n'+(r.stdout??'')+(r.stderr??'')+'\nEXIT_CODE='+r.status);if(r.error)throw r.error;return r;}
const semantics=String.raw`#include <iostream>
#include <iomanip>
#include <sstream>
#include <limits>
#include <cmath>
#include <cassert>
int main(){
 static_assert(sizeof(int)==4,"probe expects 32-bit int");
 static_assert(std::numeric_limits<float>::is_iec559 && std::numeric_limits<float>::digits==24,"probe expects binary32 float");
 int rhs=0; bool value=(2*3)||(++rhs,2+5); assert(value&&rhs==0);
 std::cout<<"short_circuit value="<<value<<" rhs_evaluations="<<rhs<<"\n";
 std::ostringstream output;int N=4;
 for(int i=0;i<N;i++){
  for(int j=1;j<i;j++)
   if(i*j%2==0)output<<i<<"#";
  continue;
 }
 output<<"0";assert(output.str()=="2#3#0");std::cout<<"continue_outer output="<<output.str()<<"\n";
 N=1;int part1=N%12,part2=N%10;std::cout<<"numbering N=1 -> "<<std::setw(2)<<std::setfill('0')<<part1<<"-"<<part2<<" (statement requires 00-0)\n";assert(part1==1&&part2==1);
 int scores[]={6,6,6,0,0,0,0,0},total_score=0,high_count=0;
 for(int score:scores){total_score+=score;if(score>=6)high_count+=1;}
 assert(total_score==18&&high_count==3);std::cout<<"total_score="<<total_score<<" high_count="<<high_count<<" code_output="<<(high_count>=5?total_score:0)<<" (statement omits this case)\n";
 float target=1.65,low=1.18,high=2.12;
 float dl=std::abs(low-target),dh=std::abs(high-target);assert(dl>dh);
 std::cout<<std::setprecision(10)<<"binary32 target="<<target<<" low="<<low<<" high="<<high<<" diff_low="<<dl<<" diff_high="<<dh<<"\n";
 float best_height=0,min_diff=100;
 for(float h:{low,high}){float diff=std::abs(h-target);if(diff<min_diff||(diff==min_diff&&h<best_height)){min_diff=diff;best_height=h;}}
 assert(best_height==high);std::cout<<"mcq14 selected="<<best_height<<"\n";
 best_height=0;min_diff=100;
 for(float h:{low,high}){float diff=h>target?h-target:target-h;if(diff<min_diff){min_diff=diff;best_height=h;}else if(diff==min_diff){if(h<best_height)best_height=h;}}
 assert(best_height==high);std::cout<<"mcq15 selected="<<best_height<<"\n";
}`;
const overflow=String.raw`#include <iostream>
int main(){static_assert(sizeof(int)==4,"32-bit int required");int N;std::cin>>N;int i=0,Nbase=1,rst=0;
while(N!=0){rst=rst+N%10*Nbase;N/=10,Nbase*=10;i+=1;}
std::cout<<rst;}`;
try{
 const version=run(compiler,['--version']);assert.equal(version.status,0);
 writeFileSync(resolve(root,out,'gesp-p0-semantics.cpp'),semantics);writeFileSync(resolve(root,out,'gesp-int-boundary.cpp'),overflow);
 for(const name of ['gesp-p0-semantics','gesp-int-boundary'])assert.equal(run(compiler,['-std=c++11','-O0','-fsanitize=undefined','-fno-sanitize-recover=undefined',out+'/'+name+'.cpp','-o',out+'/'+name]).status,0);
 assert.equal(run('./'+out+'/gesp-p0-semantics',[]).status,0);
 const safe=run('./'+out+'/gesp-int-boundary',[],'999999999\n');assert.equal(safe.status,0);assert.equal(safe.stdout,'999999999');
 const unsafe=run('./'+out+'/gesp-int-boundary',[],'1000000000\n');assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/signed integer overflow/);
 log.push('PASS: short circuit, outer continue, numbering offset, total-score gap, both binary32 counterexamples and signed-overflow boundary.\nThe sanitizer failure on 1000000000 is the expected counterexample, not a passing execution.');
}finally{writeFileSync(resolve(root,out,'cpp-semantic-probes.log'),log.join('\n\n')+'\n');console.log(log.join('\n\n'));}
