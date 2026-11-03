import {z} from 'zod';
export const MATH_ACTIVITY='math6' as const;
export const MATH_FAMILIES=['decimal','relation','billing','place','ratio','golden','circle','scale','position'] as const;
export type MathFamily=typeof MATH_FAMILIES[number];
export const mathLessonIdSchema=z.string().regex(/^math6\.(?:u[167]-\d{2}|a-(?:u[23]|sp|bin)-\d{2}|b\d{2}|r-\d{2})$/);
export const MATH_CONTROLS=['a','b','total','part','den','first','second','elapsed','count','denominator','base','digits','minutes','usage','threshold','scale','radius','inner','angle','slices','assembled','sx','sy','divisor','mapCm','col','row','quadrant','distance','width','step','dx','dy','turn','mirror','measured','roll','positionView'] as const;
// Measurement identity is derived by the server; it is never an editable control.
const valuesSchema=z.record(z.string(),z.number().finite()).refine(v=>Object.keys(v).every(k=>k==='measuredRadius'||(MATH_CONTROLS as readonly string[]).includes(k)),'未知模型数值项');
export const mathStateSchema=z.object({version:z.literal('math.state.v1'),lessonId:mathLessonIdSchema,family:z.enum(MATH_FAMILIES),values:valuesSchema,trials:z.array(z.object({values:valuesSchema}).strict()).max(12),observation:z.string().max(2000)}).strict();
export type MathState=z.infer<typeof mathStateSchema>;
export const mathOperationSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('SetMathControl'),controlId:z.enum(MATH_CONTROLS),value:z.number().finite()}).strict(),
 z.object({type:z.literal('CaptureMathTrial')}).strict(),
 z.object({type:z.literal('RecordMathObservation'),text:z.string().max(2000)}).strict(),
]);
export type MathOperation=z.infer<typeof mathOperationSchema>;
const decimal=z.object({kind:z.literal('decimal'),value:z.string().regex(/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/)}).strict();
const fraction=z.object({kind:z.literal('fraction'),numerator:z.string().regex(/^-?(?:0|[1-9]\d{0,8})$/),denominator:z.string().regex(/^[1-9]\d{0,8}$/)}).strict();
export const mathResponseSchema=z.object({kind:z.literal('mathAnswer'),version:z.literal('math.answers.v1'),lessonId:mathLessonIdSchema,answers:z.array(z.discriminatedUnion('kind',[
 z.object({kind:z.literal('quantity'),id:z.string().max(20),value:z.discriminatedUnion('kind',[decimal,fraction]),unit:z.string().max(30)}).strict(),
 z.object({kind:z.literal('choice'),id:z.string().max(20),optionId:z.string().max(20)}).strict(),
])).max(8)}).strict();
export type MathResponse=z.infer<typeof mathResponseSchema>;
