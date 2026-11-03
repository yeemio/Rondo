import { browserExportPayloadSchema } from '../../../../modules/contracts/public/desktop';
import type { SaveExportResult, BrowserExportFile } from '../../../../modules/contracts/public/desktop';

export const EXPORT_LABELS = {
  ALIASES: '学习者别名与目标', CONTENT_VERSIONS: '公开任务与内容版本', PROCESS: '学习过程',
  SUBMISSIONS: '提交', FEEDBACK: '已公开反馈', EXPLANATIONS: '解释', GUARDIAN_ANNOTATIONS: '监护观察与帮助记录',
} as const;

/** Plain UTF-8 text keeps learner input inert; no HTML rendering or script interpolation. */
export function exportFiles(input: unknown, ref: string): BrowserExportFile[] {
  const payload = browserExportPayloadSchema.parse(input);
  const lines = ['Rondo · 回旋曲 — 本家庭学习导出摘要', `导出标识：${ref}`, `格式版本：${payload.schemaVersion}`,
    `生成时间：${new Date(payload.generatedAt).toISOString()}`, `范围校验：${payload.scopeHash}`,
    '范围：当前解锁监护人的本家庭，按确认类别导出。生成时读取当前事实，并非准备时快照。',
    '不含凭据、会话、私有规则/答案/测试、其他家庭数据或工程控制文件。', ''];
  for (const [key, records] of Object.entries(payload.categories)) {
    lines.push(`${EXPORT_LABELS[key as keyof typeof EXPORT_LABELS]}：${records.length} 条`, JSON.stringify(records, null, 2), '');
  }
  return [
    { name: `rondo-${ref}.json`, type: 'application/json;charset=utf-8', text: JSON.stringify(payload, null, 2) + '\n' },
    { name: `rondo-${ref}-summary.txt`, type: 'text/plain;charset=utf-8', text: lines.join('\n') },
  ];
}

/** One explicit user click starts exactly one file; no network or second click is hidden here. */
const activeExportUrls = new Map<string, string>();

/** Delete only links created by this tab for this authenticated family. */
export function clearExportObjectUrls(familyId: string): { revoked: number; failed: number } {
  let revoked = 0, failed = 0;
  for (const [url, owner] of activeExportUrls) if (owner === familyId) {
    try { URL.revokeObjectURL(url); activeExportUrls.delete(url); revoked++; } catch { failed++; }
  }
  return { revoked, failed };
}

export function downloadExportFile(file: BrowserExportFile, familyId?: string): SaveExportResult {
  try {
    const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
    if (familyId) activeExportUrls.set(url, familyId);
    const link = document.createElement('a');
    try { link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); }
    finally { link.remove(); setTimeout(() => { URL.revokeObjectURL(url); activeExportUrls.delete(url); }, 30_000); }
    return { saved: false, delivery: 'DOWNLOAD_INITIATED', detail: '已向浏览器发起这份文件的下载，请检查下载列表；是否保存到磁盘尚未证实。' };
  } catch {
    return { saved: false, delivery: 'FAILED', detail: '这份文件的下载未能发起，保存未证实。可再次点击下载，内容不会重新生成。' };
  }
}
