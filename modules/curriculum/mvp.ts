import {MATH_ACTIVITIES,MATH_LEGACY_ACTIVITIES} from './math6';
import {GESP_ACTIVITIES,GESP_LEGACY_ACTIVITIES} from './gesp';
/** Scope index and registered learning activities. */
import {AI_ADDITIONAL_ACTIVITIES} from './ai';
export const MVP_ACTIVITIES = [
  { id: 'ratio', releaseId: 'rondo.mvp.math-ratio-r1', taskId: 'mvp.math.ratio.v1', title: '橙汁和水的比', domain: '数学', source: '苏教版六上，书内第45–46页（PDF第47–48页），Rondo按教材情境改编', sourceVersion: '60820941f23b6bd043df9af0194695002ad63dca4f27b1fc3fa692e41360d3ea', prompt: ['本活动只考虑3杯纯橙汁和2杯水，不加其他材料。纯橙汁与水的比怎样表示？', '把整份配方扩大两倍，观察杯数，再说明“前项”和“后项”为什么不能交换。'], explain: '解释纯橙汁与水的比、纯橙汁占整份饮料的几分之几有什么不同。配方扩大后，关系为何不变？' },
  { id: 'cpp', releaseId: 'rondo.mvp.gesp-202303-p1-r1', taskId: 'mvp.gesp.202303.p1.v1', title: '画三角形', domain: 'GESP C++二级', source: 'CCF GESP 2023年3月C++二级编程题1，202303.pdf第7–8页；参考程序第8页。Rondo解析另编。', sourceVersion: '202303-p1-statement-v1', prompt: ['输入正整数n（2≤n≤40），第1行输出1个字母，第2行2个，依次递增。按从上到下、从左到右的次序填入A–Z，用完Z后回到A。每行右侧不要有多余空格。', '输入一行正整数n，输出n行三角形。样例：输入3，输出三行 A、BC、DEF；输入7，末行为VWXYZAB。'], explain: '解释字母编号为什么要跨行保存，怎样从Z回到A，以及n=40时如何保持每行长度。' },
  { id: 'ai-a7', releaseId: 'rondo.mvp.ai-a7-r1', taskId: 'mvp.ai.a7.v1', title: '回答好听就可信吗', domain: 'AI通识', source: 'A7，Rondo固定合成公园材料；设计依据NIST AI 600-1（2024）和UNESCO学生AI能力框架。公园、回答均为虚构。', sourceVersion: 'rondo-ai-a7-synthetic-v1', prompt: ['模拟AI回答：“回旋公园每天8点开放，园里可以喂鹿，乘7路公交一定能到。”', '先预测这段话是否都可信，再逐张打开资料卡，给三项说法标注“资料支持”“与资料冲突”或“依据不足”。这里只核查给定材料，不代表联网查证。'], explain: '分别指出你用哪张卡支持判断，哪项还应向谁确认。流畅、自信的语气为什么不能代替证据？' },
] as const;
export const MATH_SCOPE = [ ['小数乘法和除法（二）',1],['混合运算与数量关系（三）',14],['生活中的分段计费',26],['数与运算的再认识',30],['二进制的秘密',42],['比和比例',44],['神奇的黄金比',64],['圆',68],['体育中的数学',88],['放大与缩小',92],['确定位置',103],['期末复习',112] ] as const;
export const GESP_SESSIONS = ['2023-03','2023-06','2023-09','2023-12','2024-03','2024-06','2024-09','2024-12','2025-03','2025-06','2025-09','2025-12','2026-03','2026-06','2026-09'];
export const AI_SCOPE = ['A1 身边哪些是AI','A2 AI是怎样发展来的','A3 例子为什么重要','A4 训练和使用有什么不同','A5 文字怎样变成token','A6 大模型怎样接着说','A7 回答好听就可信吗','A8 我和AI怎样合作'];
export const AI_CARDS = [ {id:'hours', title:'开放时间公告', text:'回旋公园周二至周日8:00–17:00开放，周一闭园。公告版本：合成2026-10。'}, {id:'animals',title:'园内规则',text:'园区设有鹿苑。为动物健康，请勿投喂。规则版本：合成2026-10。'}, {id:'bus',title:'交通资料的范围',text:'这份公园资料只列出步行入口，没有公交线路。此卡没有证明7路能到，也没有证明7路不能到。'} ] as const;
export const CPP_STARTER = '#include <iostream>\nusing namespace std;\nint main() {\n    int n;\n    cin >> n;\n    // 请从这里写出你的方法\n    return 0;\n}\n';
export const COMPILER_CONTRACT = 'rondo.gesp.gcc13.2.cpp11.linux-arm64.v1';

export const SUPERSEDED_ACTIVITIES=[...MATH_LEGACY_ACTIVITIES,...GESP_LEGACY_ACTIVITIES];
export function supersededActivityNotice(releaseId:string):string|undefined{return SUPERSEDED_ACTIVITIES.some(a=>a.releaseId===releaseId)?'这是已修订的旧版r1活动，仅供恢复和回看原题、草稿与历史记录，不再用于新作答或任务达成。旧版“已完成”及核对反馈是当时的原始记录，不代表已满足新版要求。请返回目录开始r2新版；原记录不会被改写或计为新版完成。':undefined;}
export const LEARNING_ACTIVITIES=[...MVP_ACTIVITIES,...AI_ADDITIONAL_ACTIVITIES,...GESP_ACTIVITIES,...MATH_ACTIVITIES,...SUPERSEDED_ACTIVITIES] as const;
export const AI_ACTIVITIES=['ai-a1','ai-a2','ai-a3','ai-a4','ai-a5','ai-a6','ai-a7','ai-a8'].map(id=>LEARNING_ACTIVITIES.find(a=>a.id===id)!);
