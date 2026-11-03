/** Closed past-paper reasoning record; no executable content or grading truth. */
import {z} from 'zod';
export const GESP_ACTIVITIES=['gesp-objective','gesp-program'] as const;
export const gespQuestionIdSchema=z.string().regex(/^gesp2\.20\d{4}\.(?:mcq(?:0[1-9]|1[0-5])|tf(?:0[1-9]|10)|p0[12])$/);
export const gespStateSchema=z.object({version:z.literal('gesp.state.v1'),questionId:gespQuestionIdSchema,reasoning:z.object({given:z.string().max(4000),steps:z.string().max(4000),check:z.string().max(4000)}).strict()}).strict();
export type GespState=z.infer<typeof gespStateSchema>;
export const gespReasoningOperationSchema=z.object({type:z.literal('RecordGespReasoning'),fieldId:z.enum(['given','steps','check']),text:z.string().max(4000)}).strict();
export const GESP_TOPICS={B:'计算机与语言基础',E:'类型与表达式',C:'条件与逻辑',L:'循环推演',N:'嵌套循环',D:'数位与数论',G:'图形与输出',A:'算法与边界'} as const;
export const GESP_REASONING_PROMPTS={
 B:['题目中的设备或概念承担什么任务？','比较两个选项的功能或定义，有什么区别？','用一个例子或反例核查自己的选择。'],
 E:['先记录变量类型、初值和字面量的含义。','按括号、优先级和类型转换写出中间结果。','区分表达式的值、类型和真正打印的内容。'],
 C:['写出输入值与每个完整条件。','按顺序判断真假，记录走了哪条分支。','换一个边界值，或给一个不等价的反例。'],
 L:['写下循环开始前的状态。','逐轮记录条件、循环体与更新；遇到跳转也记下。','写出退出原因及循环外还保留的变量值。'],
 N:['分别记录外层与内层的范围和初值。','按外层每一轮列出内层次数或关键状态。','核对break、continue属于哪层及退出后的值。'],
 D:['写出数位、因子、区间或题目要求的关系。','选择一个具体输入，列出取位或枚举的过程。','检查端点、0/1、重复数位或平方根附近的情况。'],
 G:['写下行列从0还是1编号，以及字符或数值规则。','列出首行、中间行、末行或一个关键格的推演。','核对宽高、分隔符、换行和最边缘的格子。'],
 A:['用自己的话列出输入、输出和限制。','用一个样例写出算法关键中间状态。','挑一个可能让错误解法失败的边界并解释。'],
} as const;
