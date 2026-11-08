/**
 * 任务界面的文案（中文、大白话）。集中放在这里，便于核对与测试：
 * 界面任何位置都不显示原始命令，也不出现 Codex 的内部名词。
 */
export const COPY = {
  standardTitle: '标准模式（推荐）',
  standardDesc: '标准模式：AI 只能修改这个任务的副本；已阻止读取密钥、账号凭证等敏感位置，其他位置 AI 仍可读取；默认不能联网。碰到权限边界时操作会失败，结果里会告诉你。',
  fullTrustTitle: '完全信任模式',
  fullTrustDesc: '完全信任模式：AI 拥有你这个账户的全部权限。每个任务开工前都要你单独确认。',
  fullTrustRisk: 'AI 将拥有你这个电脑账户的全部权限：可以读取任何文件、联网、修改项目以外的文件，可能自行推送代码；它读到的内容会发送给 AI 服务商；对项目以外的修改无法撤销。仅对本任务有效。',
  fullTrustAck: '我已了解风险',
  fullTrustConfirm: '确认并开工',
  fullTrustCancel: '取消，回到标准模式',
  fullTrustBadge: '完全信任',
  fullTrustPreselected: '这个项目上次选了完全信任模式，已为你预选。每个任务开工前仍需要重新确认。',
  netLabel: '允许联网（例如安装依赖）——开启后 AI 可访问任意网站。',
  extraDirLabel: '允许修改另一个文件夹',
  extraDirAdd: '添加文件夹…',
  extraDirRemove: '移除',
  extraDirNone: '没有额外的文件夹：AI 只能修改这个任务的副本。',
  checksTitle: '开工后会自动运行的检查',
  checksNone: '这个项目没有可运行的构建或测试脚本，因此验收时这些项目会显示“未检查”。',
  checksNote: '已绑定当前脚本内容，脚本被改动后此项检查会标为未检查。',
  startButton: '批准并开工',
  stopButton: '停止',
  incompleteTitle: 'AI 报告以下操作未能完成',
  incompleteNotice: '这是 AI 自己的说法，不一定完整，也不代表一定准确；请对照下面应用自己验证过的事实。',
  incompleteNone: 'AI 没有报告未完成的操作。（这同样只是 AI 自己的说法。）',
  incompleteRaw: '没能识别出具体操作。AI 的原话如下：',
  factsTitle: '应用自己验证过的事实',
  unexpected: '出现了一次意外的权限请求，已自动拒绝。',
  noProgress: '正在准备…',
} as const;
